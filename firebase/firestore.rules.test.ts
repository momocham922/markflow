/**
 * Firestore SECURITY-RULES tests (emulator-backed).
 *
 * Runs against a live Firestore emulator via @firebase/rules-unit-testing. NOT part
 * of the default `pnpm test` glob (offline jsdom) — run with `pnpm test:rules`, which
 * wraps this in `firebase emulators:exec` so the emulator is up first.
 *
 * Coverage:
 *  - users / user_settings (own-only)
 *  - documents CRUD ACL + collaborator-freeze + collab-ceiling
 *  - documents subcollections (versions / research_sessions): the B3 fix — owner may
 *    seed under a not-yet-synced parent, but cross-doc injection into an EXISTING
 *    parent is denied; collaborator/team access is honored (Windows persistence bug)
 *  - teams: create forbids billing/seatAssignments seeding; read = members only;
 *    billing/seatAssignments/ownerId frozen; T3 membership tightening (owner+manager
 *    manage, regular members self-leave only, no self-escalation to manager)
 *  - server-only collections (entitlements / usage / stripe* / iap* / teamSeats /
 *    batchLocks / feedback*) deny all client writes; own-read where allowed
 *  - error_logs / crash_reports own-uid stamp
 */
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  type Firestore,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const PROJECT_ID = "demo-markflow-rules";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Actors
const OWNER = "owner_uid";
const ADMIN = "admin_uid";
const MEMBER = "member_uid";
const OUTSIDER = "outsider_uid";
const COLLAB = "collab_uid";
const VICTIM = "victim_uid";

let testEnv: RulesTestEnvironment;

/** Firestore handle authenticated as `uid`. */
function as(uid: string): Firestore {
  return testEnv.authenticatedContext(uid).firestore();
}
function asAnon(): Firestore {
  return testEnv.unauthenticatedContext().firestore();
}

beforeAll(async () => {
  const emuHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const [host, portStr] = emuHost.split(":");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(join(__dirname, "firestore.rules"), "utf8"),
      host,
      port: Number(portStr),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

/** Seed docs with rules DISABLED (fixtures / server-written state). */
async function seed(fn: (db: Firestore) => Promise<void>) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await fn(ctx.firestore());
  });
}

// ---------------------------------------------------------------------------
// users / user_settings
// ---------------------------------------------------------------------------
describe("users", () => {
  it("owner reads/writes own doc", async () => {
    await assertSucceeds(
      setDoc(doc(as(OWNER), "users", OWNER), { email: "o@x.com" }),
    );
    await assertSucceeds(getDoc(doc(as(OWNER), "users", OWNER)));
  });
  it("cannot read another user's doc (directory enumeration guard)", async () => {
    await seed((db) => setDoc(doc(db, "users", VICTIM), { email: "v@x.com" }));
    await assertFails(getDoc(doc(as(OUTSIDER), "users", VICTIM)));
  });
  it("anonymous denied", async () => {
    await assertFails(getDoc(doc(asAnon(), "users", OWNER)));
  });
});

describe("user_settings", () => {
  it("own read/write incl. ai_chats subcollection", async () => {
    await assertSucceeds(
      setDoc(doc(as(OWNER), "user_settings", OWNER), { theme: "dark" }),
    );
    await assertSucceeds(
      setDoc(doc(as(OWNER), "user_settings", OWNER, "ai_chats", "c1"), {
        m: 1,
      }),
    );
  });
  it("other user's settings denied", async () => {
    await assertFails(
      setDoc(doc(as(OUTSIDER), "user_settings", VICTIM), { theme: "dark" }),
    );
  });
});

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------
describe("documents CRUD", () => {
  it("owner creates own doc; cannot create with someone else's ownerId", async () => {
    await assertSucceeds(
      setDoc(doc(as(OWNER), "documents", "d1"), {
        ownerId: OWNER,
        title: "mine",
      }),
    );
    await assertFails(
      setDoc(doc(as(OUTSIDER), "documents", "d2"), {
        ownerId: VICTIM, // phishing injection into victim's sidebar
        title: "evil",
      }),
    );
  });

  it("create denied when collaborators map exceeds ceiling", async () => {
    const collaborators: Record<string, { role: string }> = {};
    for (let i = 0; i <= 500; i++) collaborators[`u${i}`] = { role: "viewer" };
    await assertFails(
      setDoc(doc(as(OWNER), "documents", "big"), {
        ownerId: OWNER,
        collaborators,
      }),
    );
  });

  it("owner/collaborator/team/shareLink read; outsider denied", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "documents", "shared"), {
        ownerId: VICTIM,
        collaborators: { [COLLAB]: { role: "editor" } },
        collaboratorUids: [COLLAB],
      });
      await setDoc(doc(db, "documents", "linked"), {
        ownerId: VICTIM,
        shareLink: { enabled: true },
      });
      await setDoc(doc(db, "teams", "t1"), {
        ownerId: VICTIM,
        memberUids: [VICTIM, MEMBER],
      });
      await setDoc(doc(db, "documents", "teamdoc"), {
        ownerId: VICTIM,
        teamId: "t1",
      });
    });
    await assertSucceeds(getDoc(doc(as(VICTIM), "documents", "shared")));
    await assertSucceeds(getDoc(doc(as(COLLAB), "documents", "shared")));
    await assertFails(getDoc(doc(as(OUTSIDER), "documents", "shared")));
    await assertSucceeds(getDoc(doc(as(OUTSIDER), "documents", "linked"))); // public link
    await assertSucceeds(getDoc(doc(as(MEMBER), "documents", "teamdoc")));
    await assertFails(getDoc(doc(as(OUTSIDER), "documents", "teamdoc")));
  });

  it("editor may edit content but NOT ownership/sharing fields", async () => {
    await seed((db) =>
      setDoc(doc(db, "documents", "d"), {
        ownerId: VICTIM,
        collaborators: { [COLLAB]: { role: "editor" } },
        content: "orig",
      }),
    );
    // content edit OK
    await assertSucceeds(
      setDoc(
        doc(as(COLLAB), "documents", "d"),
        { content: "edited" },
        { merge: true },
      ),
    );
    // ownership takeover denied
    await assertFails(
      setDoc(
        doc(as(COLLAB), "documents", "d"),
        { ownerId: COLLAB },
        { merge: true },
      ),
    );
    // self-promotion via collaborators denied
    await assertFails(
      setDoc(
        doc(as(COLLAB), "documents", "d"),
        {
          collaborators: {
            [COLLAB]: { role: "editor" },
            [OUTSIDER]: { role: "editor" },
          },
        },
        { merge: true },
      ),
    );
    // enabling public shareLink denied
    await assertFails(
      setDoc(
        doc(as(COLLAB), "documents", "d"),
        { shareLink: { enabled: true } },
        { merge: true },
      ),
    );
  });

  it("owner deletes; non-owner cannot delete", async () => {
    await seed((db) =>
      setDoc(doc(db, "documents", "d"), {
        ownerId: VICTIM,
        collaborators: { [COLLAB]: { role: "editor" } },
      }),
    );
    await assertFails(deleteDoc(doc(as(COLLAB), "documents", "d")));
    await assertSucceeds(deleteDoc(doc(as(VICTIM), "documents", "d")));
  });
});

// ---------------------------------------------------------------------------
// documents subcollections — B3 fix (Windows persistence bug)
// ---------------------------------------------------------------------------
describe("document subcollections (versions / research_sessions)", () => {
  for (const sub of ["versions", "research_sessions"] as const) {
    describe(sub, () => {
      it("owner seeds under a parent NOT yet in the cloud (mid first-sync)", async () => {
        // No parent doc exists — the owner-seed path must allow it.
        await assertSucceeds(
          setDoc(doc(as(OWNER), "documents", "fresh", sub, "s1"), {
            ownerId: OWNER,
            data: "x",
          }),
        );
      });

      it("cross-doc injection into an EXISTING victim parent is denied", async () => {
        await seed((db) =>
          setDoc(doc(db, "documents", "victimDoc"), { ownerId: VICTIM }),
        );
        // Attacker cannot seed a subcollection under a doc it does not control,
        // even stamping its own ownerId — the parent exists so subOwnerSeed fails
        // and subParentGrants requires real access.
        await assertFails(
          setDoc(doc(as(OUTSIDER), "documents", "victimDoc", sub, "s1"), {
            ownerId: OUTSIDER,
            data: "evil",
          }),
        );
      });

      it("collaborator and team member get subcollection access", async () => {
        await seed(async (db) => {
          await setDoc(doc(db, "documents", "shared"), {
            ownerId: VICTIM,
            collaboratorUids: [COLLAB],
          });
          await setDoc(doc(db, "teams", "t1"), {
            ownerId: VICTIM,
            memberUids: [VICTIM, MEMBER],
          });
          await setDoc(doc(db, "documents", "teamdoc"), {
            ownerId: VICTIM,
            teamId: "t1",
          });
        });
        await assertSucceeds(
          setDoc(doc(as(COLLAB), "documents", "shared", sub, "s1"), {
            ownerId: COLLAB,
          }),
        );
        await assertSucceeds(
          setDoc(doc(as(MEMBER), "documents", "teamdoc", sub, "s1"), {
            ownerId: MEMBER,
          }),
        );
        await assertFails(
          setDoc(doc(as(OUTSIDER), "documents", "shared", sub, "s1"), {
            ownerId: OUTSIDER,
          }),
        );
      });

      it("owner reads back its own subcollection docs", async () => {
        await seed((db) =>
          setDoc(doc(db, "documents", "d1", sub, "s1"), { ownerId: OWNER }),
        );
        // parent does not exist → subOwnerSeedRead path
        await assertSucceeds(
          getDoc(doc(as(OWNER), "documents", "d1", sub, "s1")),
        );
        await assertFails(
          getDoc(doc(as(OUTSIDER), "documents", "d1", sub, "s1")),
        );
      });
    });
  }
});

// ---------------------------------------------------------------------------
// teams — billing freezes + T3 membership tightening
// ---------------------------------------------------------------------------
describe("teams", () => {
  /** Seed a funded team: owner + admin (managers) + regular member. */
  async function seedTeam() {
    await seed((db) =>
      setDoc(doc(db, "teams", "team1"), {
        name: "Acme",
        ownerId: OWNER,
        memberUids: [OWNER, ADMIN, MEMBER],
        managerUids: [OWNER, ADMIN],
        members: [
          { uid: OWNER, email: "o@x.com", role: "owner" },
          { uid: ADMIN, email: "a@x.com", role: "admin" },
          { uid: MEMBER, email: "m@x.com", role: "member" },
        ],
        billing: { status: "active", seats: 3, ownerUid: OWNER },
        seatAssignments: [OWNER, ADMIN, MEMBER],
      }),
    );
  }

  it("create is allowed but MUST NOT seed billing/seatAssignments", async () => {
    await assertSucceeds(
      setDoc(doc(as(OWNER), "teams", "new1"), {
        ownerId: OWNER,
        memberUids: [OWNER],
        managerUids: [OWNER],
      }),
    );
    await assertFails(
      setDoc(doc(as(OWNER), "teams", "new2"), {
        ownerId: OWNER,
        memberUids: [OWNER],
        billing: { status: "active" },
      }),
    );
    await assertFails(
      setDoc(doc(as(OWNER), "teams", "new3"), {
        ownerId: OWNER,
        memberUids: [OWNER],
        seatAssignments: [OWNER],
      }),
    );
  });

  it("read requires membership", async () => {
    await seedTeam();
    await assertSucceeds(getDoc(doc(as(MEMBER), "teams", "team1")));
    await assertFails(getDoc(doc(as(OUTSIDER), "teams", "team1")));
  });

  it("member CANNOT forge billing or seatAssignments", async () => {
    await seedTeam();
    await assertFails(
      setDoc(
        doc(as(MEMBER), "teams", "team1"),
        { billing: { status: "active", seats: 999 } },
        { merge: true },
      ),
    );
    await assertFails(
      setDoc(
        doc(as(MEMBER), "teams", "team1"),
        { seatAssignments: [OWNER, ADMIN, MEMBER, OUTSIDER] },
        { merge: true },
      ),
    );
  });

  it("ownerId frozen; owner cannot be removed from memberUids", async () => {
    await seedTeam();
    await assertFails(
      setDoc(
        doc(as(ADMIN), "teams", "team1"),
        { ownerId: ADMIN }, // takeover
        { merge: true },
      ),
    );
    await assertFails(
      setDoc(
        doc(as(OWNER), "teams", "team1"),
        { memberUids: [ADMIN, MEMBER] }, // lock owner out
        { merge: true },
      ),
    );
  });

  it("owner and managers manage membership; regular members cannot add/evict", async () => {
    await seedTeam();
    // Owner adds a member.
    await assertSucceeds(
      setDoc(
        doc(as(OWNER), "teams", "team1"),
        { memberUids: [OWNER, ADMIN, MEMBER, OUTSIDER] },
        { merge: true },
      ),
    );
    // Admin (manager) adds a regular member (managerUids unchanged).
    await assertSucceeds(
      setDoc(
        doc(as(ADMIN), "teams", "team1"),
        { memberUids: [OWNER, ADMIN, MEMBER, OUTSIDER] },
        { merge: true },
      ),
    );
    // Regular member cannot add an arbitrary uid (COLLAB is genuinely new here,
    // so this is a real membership growth — not a no-op against the prior state).
    await assertFails(
      setDoc(
        doc(as(MEMBER), "teams", "team1"),
        { memberUids: [OWNER, ADMIN, MEMBER, OUTSIDER, COLLAB] },
        { merge: true },
      ),
    );
    // Regular member cannot evict another member (self stays → not a self-leave).
    await assertFails(
      setDoc(
        doc(as(MEMBER), "teams", "team1"),
        { memberUids: [OWNER, MEMBER] }, // dropped ADMIN + OUTSIDER
        { merge: true },
      ),
    );
  });

  it("regular member may self-leave (remove only their own uid)", async () => {
    await seedTeam();
    await assertSucceeds(
      setDoc(
        doc(as(MEMBER), "teams", "team1"),
        { memberUids: [OWNER, ADMIN] },
        { merge: true },
      ),
    );
  });

  it("member cannot escalate self into managerUids", async () => {
    await seedTeam();
    await assertFails(
      setDoc(
        doc(as(MEMBER), "teams", "team1"),
        { managerUids: [OWNER, ADMIN, MEMBER] },
        { merge: true },
      ),
    );
  });

  it("admin (manager) may self-leave, dropping self from both lists", async () => {
    await seedTeam();
    await assertSucceeds(
      setDoc(
        doc(as(ADMIN), "teams", "team1"),
        { memberUids: [OWNER, MEMBER], managerUids: [OWNER] },
        { merge: true },
      ),
    );
  });

  it("member may edit non-membership fields (rename)", async () => {
    await seedTeam();
    await assertSucceeds(
      setDoc(
        doc(as(MEMBER), "teams", "team1"),
        { name: "Renamed" },
        { merge: true },
      ),
    );
  });

  it("only owner deletes the team", async () => {
    await seedTeam();
    await assertFails(deleteDoc(doc(as(ADMIN), "teams", "team1")));
    await assertSucceeds(deleteDoc(doc(as(OWNER), "teams", "team1")));
  });
});

// ---------------------------------------------------------------------------
// server-only collections
// ---------------------------------------------------------------------------
describe("server-only collections", () => {
  it("entitlements: own read OK, all writes denied, other read denied", async () => {
    await seed((db) => setDoc(doc(db, "entitlements", OWNER), { plan: "pro" }));
    await assertSucceeds(getDoc(doc(as(OWNER), "entitlements", OWNER)));
    await assertFails(getDoc(doc(as(OUTSIDER), "entitlements", OWNER)));
    await assertFails(
      setDoc(doc(as(OWNER), "entitlements", OWNER), { plan: "pro" }), // self-grant
    );
  });

  it("usage: own read OK (doc + months), writes denied", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "usage", OWNER), { x: 1 });
      await setDoc(doc(db, "usage", OWNER, "months", "2026-09"), {
        aiCalls: 5,
      });
    });
    await assertSucceeds(getDoc(doc(as(OWNER), "usage", OWNER)));
    await assertSucceeds(
      getDoc(doc(as(OWNER), "usage", OWNER, "months", "2026-09")),
    );
    await assertFails(setDoc(doc(as(OWNER), "usage", OWNER), { x: 2 }));
    await assertFails(
      setDoc(doc(as(OWNER), "usage", OWNER, "months", "2026-09"), {
        aiCalls: 0,
      }),
    );
  });

  it("stripe/iap/teamSeats/batchLocks fully denied to clients", async () => {
    for (const path of [
      ["stripeEvents", "e1"],
      ["stripeCustomers", "c1"],
      ["batchLocks", OWNER],
      ["teamSeats", OWNER],
      ["iapEvents", "e1"],
      ["iapCustomers", "k1"],
    ] as const) {
      await seed((db) => setDoc(doc(db, path[0], path[1]), { x: 1 }));
      await assertFails(getDoc(doc(as(OWNER), path[0], path[1])));
      await assertFails(setDoc(doc(as(OWNER), path[0], path[1]), { x: 2 }));
    }
  });

  it("feedback: own read OK, writes denied; feedback_groups fully denied", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "feedback", "f1"), { uid: OWNER, text: "hi" });
      await setDoc(doc(db, "feedback_groups", "fp1"), { count: 1 });
    });
    await assertSucceeds(getDoc(doc(as(OWNER), "feedback", "f1")));
    await assertFails(getDoc(doc(as(OUTSIDER), "feedback", "f1")));
    await assertFails(setDoc(doc(as(OWNER), "feedback", "f2"), { uid: OWNER }));
    await assertFails(getDoc(doc(as(OWNER), "feedback_groups", "fp1")));
  });
});

// ---------------------------------------------------------------------------
// error_logs / crash_reports — own-uid stamp
// ---------------------------------------------------------------------------
describe("error_logs & crash_reports", () => {
  it("error_logs: create/read only own-uid stamped", async () => {
    await assertSucceeds(
      setDoc(doc(as(OWNER), "error_logs", "l1"), { uid: OWNER, msg: "x" }),
    );
    await assertFails(
      setDoc(doc(as(OWNER), "error_logs", "l2"), { uid: VICTIM, msg: "x" }),
    );
    await seed((db) =>
      setDoc(doc(db, "error_logs", "l3"), { uid: VICTIM, msg: "y" }),
    );
    await assertFails(getDoc(doc(as(OWNER), "error_logs", "l3")));
  });

  it("crash_reports: create/read only own-userId stamped", async () => {
    await assertSucceeds(
      setDoc(doc(as(OWNER), "crash_reports", "r1"), {
        userId: OWNER,
        stack: "x",
      }),
    );
    await assertFails(
      setDoc(doc(as(OWNER), "crash_reports", "r2"), {
        userId: VICTIM,
        stack: "x",
      }),
    );
    await seed((db) =>
      setDoc(doc(db, "crash_reports", "r3"), { userId: VICTIM }),
    );
    await assertFails(getDoc(doc(as(OWNER), "crash_reports", "r3")));
  });
});
