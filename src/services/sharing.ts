import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  arrayUnion,
  arrayRemove,
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

  const collab: Collaborator = {
    uid: usersSnap.empty ? "" : usersSnap.docs[0].id,
    email,
    role,
    addedAt: Date.now(),
  };

  await updateDoc(doc(firestore, "documents", docId), {
    collaborators: arrayUnion(collab),
  });
}

/** Remove a collaborator from a document */
export async function removeCollaborator(
  docId: string,
  collaborator: Collaborator,
): Promise<void> {
  await updateDoc(doc(firestore, "documents", docId), {
    collaborators: arrayRemove(collaborator),
  });
}

/** Update a collaborator's role */
export async function updateCollaboratorRole(
  docId: string,
  oldCollab: Collaborator,
  newRole: "editor" | "viewer",
): Promise<void> {
  await removeCollaborator(docId, oldCollab);
  await addCollaborator(docId, oldCollab.email, newRole);
}

/** Fetch documents shared with a user (as collaborator) */
export async function fetchSharedWithMe(
  email: string,
): Promise<{ id: string; title: string; role: "editor" | "viewer" }[]> {
  // Firestore doesn't support array-contains on nested fields well,
  // so we query all docs and filter client-side for now
  // TODO: For scale, denormalize into a separate collection
  const q = query(collection(firestore, "documents"));
  const snap = await getDocs(q);
  const results: { id: string; title: string; role: "editor" | "viewer" }[] = [];

  for (const d of snap.docs) {
    const data = d.data();
    const collabs = (data.collaborators || []) as Collaborator[];
    const match = collabs.find((c) => c.email === email);
    if (match) {
      results.push({ id: d.id, title: data.title, role: match.role });
    }
  }

  return results;
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
    members: [
      { uid: owner.uid, email: owner.email, role: "owner", joinedAt: Date.now() },
    ],
    createdAt: serverTimestamp(),
  });
  return teamId;
}

/** Fetch teams a user belongs to */
export async function fetchUserTeams(uid: string): Promise<Team[]> {
  // Firestore: query teams where user is a member
  const allTeams = await getDocs(collection(firestore, TEAMS_COLLECTION));
  return allTeams.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Team)
    .filter((t) => t.members.some((m) => m.uid === uid));
}

/** Add a member to a team */
export async function addTeamMember(
  teamId: string,
  member: { email: string; uid?: string; role: "admin" | "member" },
): Promise<void> {
  const teamMember: TeamMember = {
    uid: member.uid || "",
    email: member.email,
    role: member.role,
    joinedAt: Date.now(),
  };
  await updateDoc(doc(firestore, TEAMS_COLLECTION, teamId), {
    members: arrayUnion(teamMember),
  });
}

/** Remove a member from a team */
export async function removeTeamMember(
  teamId: string,
  member: TeamMember,
): Promise<void> {
  await updateDoc(doc(firestore, TEAMS_COLLECTION, teamId), {
    members: arrayRemove(member),
  });
}

/** Delete a team */
export async function deleteTeam(teamId: string): Promise<void> {
  await deleteDoc(doc(firestore, TEAMS_COLLECTION, teamId));
}

/** Share a document with an entire team */
export async function shareDocWithTeam(
  docId: string,
  team: Team,
  role: "editor" | "viewer",
): Promise<void> {
  const ref = doc(firestore, "documents", docId);
  // Add all team members as collaborators
  for (const member of team.members) {
    const collab: Collaborator = {
      uid: member.uid,
      email: member.email,
      role,
      addedAt: Date.now(),
    };
    await updateDoc(ref, {
      collaborators: arrayUnion(collab),
    });
  }
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
