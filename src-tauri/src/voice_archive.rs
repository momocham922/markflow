//! Orphaned Refine-archive rescue (std only — testable with plain `rustc --test`).
//!
//! The full-session recording is written to `temp_dir()/markflow_voice_<uuid>.pcm`
//! (16 kHz mono s16le, no header) and its path is remembered only in memory
//! (`VOICE_ARCHIVE_PATH`). When the app process dies (crash, OS kill, update),
//! that path is lost and the file becomes an orphan the UI can no longer reach —
//! the audio is still on disk but "Refine" never appears (2026-11-09: an iPhone
//! recording made while signed out was lost this way). These helpers find such
//! orphans so the existing Refine pipeline can pick them up again.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const ARCHIVE_PREFIX: &str = "markflow_voice_";
pub const ARCHIVE_SUFFIX: &str = ".pcm";
/// Suffix appended after a successful upload so the file is no longer offered.
pub const UPLOADED_SUFFIX: &str = ".uploaded";
/// One second of 16 kHz mono s16le. Anything at or below this is an empty /
/// aborted start, not a recording worth offering.
pub const MIN_ORPHAN_BYTES: u64 = 32_000;
/// Bytes per second of the archive format (16 kHz × 2 bytes, mono).
pub const ARCHIVE_BYTES_PER_SEC: u64 = 32_000;

#[derive(Debug, Clone, PartialEq)]
pub struct OrphanArchive {
    pub path: PathBuf,
    pub bytes: u64,
    pub modified: SystemTime,
}

/// `markflow_voice_<something>.pcm` (an uploaded file ends in `.pcm.uploaded`
/// and is therefore excluded).
pub fn is_archive_name(name: &str) -> bool {
    name.len() > ARCHIVE_PREFIX.len() + ARCHIVE_SUFFIX.len()
        && name.starts_with(ARCHIVE_PREFIX)
        && name.ends_with(ARCHIVE_SUFFIX)
}

/// Newest (by modification time) archive file in `dir` larger than
/// `min_bytes`. `exclude` skips one path (e.g. the archive currently being
/// written). Never opens, modifies or deletes anything.
pub fn find_newest_orphan(dir: &Path, min_bytes: u64, exclude: Option<&Path>) -> Option<OrphanArchive> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<OrphanArchive> = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(n) => n,
            None => continue,
        };
        if !is_archive_name(name) {
            continue;
        }
        let path = entry.path();
        if let Some(ex) = exclude {
            if ex == path.as_path() {
                continue;
            }
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let bytes = meta.len();
        if bytes <= min_bytes {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let better = match &best {
            None => true,
            Some(b) => modified > b.modified || (modified == b.modified && path > b.path),
        };
        if better {
            best = Some(OrphanArchive { path, bytes, modified });
        }
    }
    best
}

/// `<path>.uploaded` — where an archive is moved after its audio reached Storage.
pub fn uploaded_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(UPLOADED_SUFFIX);
    PathBuf::from(s)
}

/// Delete `*.pcm.uploaded` files in `dir` older than `max_age` (their audio is
/// already in Storage). Only touches files with the uploaded suffix.
pub fn prune_uploaded(dir: &Path, max_age: std::time::Duration) -> usize {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(n) => n,
            None => continue,
        };
        let base = match name.strip_suffix(UPLOADED_SUFFIX) {
            Some(b) => b,
            None => continue,
        };
        if !is_archive_name(base) {
            continue;
        }
        let modified = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let old_enough = now.duration_since(modified).map(|a| a > max_age).unwrap_or(false);
        if old_enough && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Milliseconds since the Unix epoch (0 if before it / unavailable).
pub fn system_time_ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> TmpDir {
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let p = std::env::temp_dir().join(format!("mf-orphan-test-{}-{}-{}", tag, std::process::id(), nanos));
            fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
        fn write(&self, name: &str, bytes: usize, age_secs: u64) -> PathBuf {
            let p = self.0.join(name);
            fs::write(&p, vec![0u8; bytes]).unwrap();
            let t = SystemTime::now() - Duration::from_secs(age_secs);
            let f = fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(t).unwrap();
            p
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn empty_dir_finds_nothing() {
        let d = TmpDir::new("empty");
        assert_eq!(find_newest_orphan(&d.0, MIN_ORPHAN_BYTES, None), None);
    }

    #[test]
    fn missing_dir_finds_nothing() {
        let d = TmpDir::new("missing");
        let gone = d.0.join("nope");
        assert_eq!(find_newest_orphan(&gone, MIN_ORPHAN_BYTES, None), None);
    }

    #[test]
    fn single_archive_is_adopted() {
        let d = TmpDir::new("single");
        let p = d.write("markflow_voice_aaaa.pcm", 64_000, 10);
        let got = find_newest_orphan(&d.0, MIN_ORPHAN_BYTES, None).expect("should find");
        assert_eq!(got.path, p);
        assert_eq!(got.bytes, 64_000);
    }

    #[test]
    fn newest_of_several_wins() {
        let d = TmpDir::new("several");
        d.write("markflow_voice_old.pcm", 64_000, 3600);
        let newest = d.write("markflow_voice_new.pcm", 64_000, 5);
        d.write("markflow_voice_mid.pcm", 640_000, 600);
        let got = find_newest_orphan(&d.0, MIN_ORPHAN_BYTES, None).expect("should find");
        assert_eq!(got.path, newest);
    }

    #[test]
    fn too_small_is_ignored() {
        let d = TmpDir::new("small");
        d.write("markflow_voice_tiny.pcm", 32_000, 5); // exactly 1s → not > min
        d.write("markflow_voice_zero.pcm", 0, 1);
        assert_eq!(find_newest_orphan(&d.0, MIN_ORPHAN_BYTES, None), None);
        // A larger but older file is still picked over newer tiny ones.
        let ok = d.write("markflow_voice_ok.pcm", 32_002, 100);
        assert_eq!(find_newest_orphan(&d.0, MIN_ORPHAN_BYTES, None).unwrap().path, ok);
    }

    #[test]
    fn other_names_and_uploaded_are_ignored() {
        let d = TmpDir::new("names");
        d.write("markflow_voice_done.pcm.uploaded", 640_000, 1);
        d.write("mf-gcs-split-x.wav", 640_000, 1);
        d.write("markflow-print.html", 640_000, 1);
        d.write("markflow_voice_.pcm", 640_000, 1); // no id part
        d.write("other_voice_x.pcm", 640_000, 1);
        assert_eq!(find_newest_orphan(&d.0, MIN_ORPHAN_BYTES, None), None);
    }

    #[test]
    fn excluded_path_is_skipped() {
        let d = TmpDir::new("exclude");
        let active = d.write("markflow_voice_active.pcm", 640_000, 1);
        let older = d.write("markflow_voice_older.pcm", 640_000, 60);
        let got = find_newest_orphan(&d.0, MIN_ORPHAN_BYTES, Some(&active)).unwrap();
        assert_eq!(got.path, older);
    }

    #[test]
    fn prune_removes_only_old_uploaded_files() {
        let d = TmpDir::new("prune");
        let old_up = d.write("markflow_voice_a.pcm.uploaded", 64_000, 8 * 24 * 3600);
        let new_up = d.write("markflow_voice_b.pcm.uploaded", 64_000, 60);
        let old_live = d.write("markflow_voice_c.pcm", 64_000, 30 * 24 * 3600);
        let old_other = d.write("something.uploaded", 64_000, 30 * 24 * 3600);
        let n = prune_uploaded(&d.0, Duration::from_secs(7 * 24 * 3600));
        assert_eq!(n, 1);
        assert!(!old_up.exists());
        assert!(new_up.exists());
        assert!(old_live.exists(), "an un-uploaded recording must never be pruned");
        assert!(old_other.exists());
    }

    #[test]
    fn uploaded_path_appends_suffix_and_is_not_an_archive_name() {
        let p = Path::new("/tmp/markflow_voice_abc.pcm");
        let u = uploaded_path(p);
        assert_eq!(u, PathBuf::from("/tmp/markflow_voice_abc.pcm.uploaded"));
        assert!(!is_archive_name(u.file_name().unwrap().to_str().unwrap()));
        assert!(is_archive_name("markflow_voice_abc.pcm"));
    }
}
