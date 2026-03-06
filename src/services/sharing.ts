import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  query,
  where,
  serverTimestamp,
  type Timestamp,
} from "firebase/firestore";

const firestore = getFirestore();

// ─── Share Links ───────────────────────────────────────────────

export interface ShareLink {
  enabled: boolean;
  token: string;
  permission: "view" | "edit";
  expiresAt: number | null; // epoch ms, null = no expiry
}

/** Generate a cryptographically random share token */
function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Enable or update a share link for a document */
export async function enableShareLink(
  docId: string,
  permission: "view" | "edit" = "view",
  expiresInMs: number | null = null,
): Promise<ShareLink> {
  const ref = doc(firestore, "documents", docId);
  const snap = await getDoc(ref);
  const existing = snap.data()?.shareLink as ShareLink | undefined;

  const shareLink: ShareLink = {
    enabled: true,
    token: existing?.token || generateToken(),
    permission,
    expiresAt: expiresInMs ? Date.now() + expiresInMs : null,
  };

  await updateDoc(ref, { shareLink });
  return shareLink;
}

/** Disable a share link (keeps the token so re-enabling gives the same URL) */
export async function disableShareLink(docId: string): Promise<void> {
  const ref = doc(firestore, "documents", docId);
  await updateDoc(ref, { "shareLink.enabled": false });
}

/** Fetch a document by share token (for viewers without login) */
export async function fetchDocumentByToken(
  token: string,
): Promise<{ id: string; title: string; content: string; permission: "view" | "edit" } | null> {
  const q = query(
    collection(firestore, "documents"),
    where("shareLink.enabled", "==", true),
    where("shareLink.token", "==", token),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;

  const docSnap = snap.docs[0];
  const data = docSnap.data();
  const shareLink = data.shareLink as ShareLink;

  // Check expiry
  if (shareLink.expiresAt && Date.now() > shareLink.expiresAt) {
    return null;
  }

  return {
    id: docSnap.id,
    title: data.title,
    content: data.content,
    permission: shareLink.permission,
  };
}

// ─── Collaborators ─────────────────────────────────────────────
// Stored as a map: { [uid]: { email, role, addedAt } }
// This matches Firestore security rules: `request.auth.uid in resource.data.collaborators.keys()`

export interface Collaborator {
  uid: string;
  email: string;
  role: "editor" | "viewer";
  addedAt: number;
}

/** Add a collaborator to a document by email */
export async function addCollaborator(
  docId: string,
  email: string,
  role: "editor" | "viewer",
): Promise<void> {
  // Look up the user by email in the users collection
  const usersQ = query(
    collection(firestore, "users"),
    where("email", "==", email),
  );
  const usersSnap = await getDocs(usersQ);

  const uid = usersSnap.empty ? "" : usersSnap.docs[0].id;
  const key = uid || email.replace(/[.#$/\[\]]/g, "_");

  const ref = doc(firestore, "documents", docId);
  const updates: Record<string, unknown> = {
    [`collaborators.${key}`]: { email, role, addedAt: Date.now() },
  };

  // Maintain collaboratorUids array for efficient querying
  if (uid) {
    const snap = await getDoc(ref);
    const existing = (snap.data()?.collaboratorUids || []) as string[];
    if (!existing.includes(uid)) {
      updates.collaboratorUids = [...existing, uid];
    }
  }

  await updateDoc(ref, updates);
}

/** Remove a collaborator from a document */
export async function removeCollaborator(
  docId: string,
  collaborator: Collaborator,
): Promise<void> {
  const key = collaborator.uid || collaborator.email.replace(/[.#$/\[\]]/g, "_");
  const ref = doc(firestore, "documents", docId);

  const updates: Record<string, unknown> = {
    [`collaborators.${key}`]: deleteField(),
  };

  // Also remove from collaboratorUids array
  if (collaborator.uid) {
    const snap = await getDoc(ref);
    const existing = (snap.data()?.collaboratorUids || []) as string[];
    updates.collaboratorUids = existing.filter((u) => u !== collaborator.uid);
  }

  await updateDoc(ref, updates);
}

/** Update a collaborator's role */
export async function updateCollaboratorRole(
  docId: string,
  oldCollab: Collaborator,
  newRole: "editor" | "viewer",
): Promise<void> {
  const key = oldCollab.uid || oldCollab.email.replace(/[.#$/\[\]]/g, "_");
  await updateDoc(doc(firestore, "documents", docId), {
    [`collaborators.${key}.role`]: newRole,
  });
}

/** Get collaborators for a document (returns array for UI compatibility) */
export async function getCollaborators(docId: string): Promise<Collaborator[]> {
  const ref = doc(firestore, "documents", docId);
  const snap = await getDoc(ref);
  const data = snap.data();
  if (!data?.collaborators) return [];

  const collabMap = data.collaborators as Record<string, { email: string; role: "editor" | "viewer"; addedAt: number }>;
  return Object.entries(collabMap).map(([uid, val]) => ({
    uid,
    email: val.email,
    role: val.role,
    addedAt: val.addedAt,
  }));
}

/** Fetch documents shared with a user (as collaborator) */
export async function fetchSharedWithMe(
  uid: string,
): Promise<{ id: string; title: string; role: "editor" | "viewer" }[]> {
  const q = query(
    collection(firestore, "documents"),
    where("collaboratorUids", "array-contains", uid),
  );

  try {
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const collabData = data.collaborators?.[uid] as { role: "editor" | "viewer" } | undefined;
      return {
        id: d.id,
        title: data.title,
        role: collabData?.role ?? "viewer",
      };
    });
  } catch (err) {
    console.warn("fetchSharedWithMe query failed:", err);
    return [];
  }
}

// ─── Teams ─────────────────────────────────────────────────────

export interface TeamMember {
  uid: string;
  email: string;
  role: "owner" | "admin" | "member";
  joinedAt: number;
}

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  members: TeamMember[];
  createdAt: Timestamp | null;
}

const TEAMS_COLLECTION = "teams";

/** Create a new team */
export async function createTeam(
  name: string,
  owner: { uid: string; email: string },
): Promise<string> {
  const teamId = crypto.randomUUID();
  const ref = doc(firestore, TEAMS_COLLECTION, teamId);
  await setDoc(ref, {
    name,
    ownerId: owner.uid,
    memberUids: [owner.uid],
    members: [
      { uid: owner.uid, email: owner.email, role: "owner", joinedAt: Date.now() },
    ],
    createdAt: serverTimestamp(),
  });
  return teamId;
}

/** Fetch teams a user belongs to */
export async function fetchUserTeams(uid: string): Promise<Team[]> {
  const q = query(
    collection(firestore, TEAMS_COLLECTION),
    where("memberUids", "array-contains", uid),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Team);
}

/** Add a member to a team */
export async function addTeamMember(
  teamId: string,
  member: { email: string; uid?: string; role: "admin" | "member" },
): Promise<void> {
  // Look up the user by email
  const usersQ = query(
    collection(firestore, "users"),
    where("email", "==", member.email),
  );
  const usersSnap = await getDocs(usersQ);
  const uid = member.uid || (usersSnap.empty ? "" : usersSnap.docs[0].id);

  const teamMember: TeamMember = {
    uid,
    email: member.email,
    role: member.role,
    joinedAt: Date.now(),
  };

  const ref = doc(firestore, TEAMS_COLLECTION, teamId);
  // Get current members, add new one
  const snap = await getDoc(ref);
  const data = snap.data();
  const members = (data?.members || []) as TeamMember[];
  const memberUids = (data?.memberUids || []) as string[];

  if (!members.some((m) => m.email === member.email)) {
    members.push(teamMember);
    if (uid && !memberUids.includes(uid)) memberUids.push(uid);
    await updateDoc(ref, { members, memberUids });
  }
}

/** Remove a member from a team */
export async function removeTeamMember(
  teamId: string,
  member: TeamMember,
): Promise<void> {
  const ref = doc(firestore, TEAMS_COLLECTION, teamId);
  const snap = await getDoc(ref);
  const data = snap.data();
  const members = ((data?.members || []) as TeamMember[]).filter(
    (m) => m.email !== member.email,
  );
  const memberUids = members.map((m) => m.uid).filter(Boolean);
  await updateDoc(ref, { members, memberUids });
}

/** Delete a team */
export async function deleteTeam(teamId: string): Promise<void> {
  await deleteDoc(doc(firestore, TEAMS_COLLECTION, teamId));
}

/** Fetch all documents belonging to a team */
export async function fetchTeamDocuments(
  teamId: string,
): Promise<{ id: string; title: string; updatedAt: number }[]> {
  const q = query(
    collection(firestore, "documents"),
    where("teamId", "==", teamId),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      title: data.title || "Untitled",
      updatedAt: data.updatedAt?.toMillis?.() ?? Date.now(),
    };
  });
}

/** Create a document within a team */
export async function createTeamDocument(
  teamId: string,
  ownerId: string,
): Promise<string> {
  const docId = crypto.randomUUID();
  const ref = doc(firestore, "documents", docId);
  await setDoc(ref, {
    title: "Untitled",
    content: "",
    ownerId,
    teamId,
    collaborators: {},
    collaboratorUids: [],
    tags: [],
    folder: "/",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docId;
}

// ─── User Profile (for looking up users by email) ──────────────

/** Save/update user profile on login */
export async function saveUserProfile(user: {
  uid: string;
  email: string;
  displayName: string | null;
}): Promise<void> {
  await setDoc(
    doc(firestore, "users", user.uid),
    {
      email: user.email,
      displayName: user.displayName,
      lastSeen: serverTimestamp(),
    },
    { merge: true },
  );
}
