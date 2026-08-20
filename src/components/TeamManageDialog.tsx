import { useState, useEffect, useRef } from "react";
import { useIMEGuard } from "@/hooks/use-ime-guard";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Users,
  Plus,
  Trash2,
  UserPlus,
  Crown,
  Shield,
  User,
  Loader2,
  CreditCard,
  Check,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { isMobile } from "@/platform";
import {
  createTeam,
  fetchUserTeams,
  addTeamMember,
  removeTeamMember,
  deleteTeam,
  isTeamManager,
  isTeamBillingActive,
  type Team,
  type TeamMember,
} from "@/services/sharing";
import {
  useEntitlementStore,
  BILLING_ENABLED,
  type BillingInterval,
} from "@/stores/entitlement-store";
import { yen, perMonth } from "@/lib/pricing";

const MAX_TEAM_SEATS = 100; // mirrors the server default (MAX_TEAM_SEATS)

interface TeamManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function roleIcon(role: string) {
  if (role === "owner") return <Crown className="h-3 w-3 text-amber-500" />;
  if (role === "admin") return <Shield className="h-3 w-3 text-blue-500" />;
  return <User className="h-3 w-3 text-muted-foreground" />;
}

/** The paid-seat count assignable to non-owner members (the owner always has access). */
function nonOwnerCount(team: Team): number {
  return team.members.filter((m) => m.role !== "owner").length;
}

// =====================================================================
// One team's card: members management + (for owner/admin) the billing block —
// buy a Team subscription (seat-aware checkout), change the paid seat count, and
// assign WHICH members hold the seats. Purchase / seat-count changes are
// desktop/web only (Apple/Google anti-steering forbids routing in-app users to
// an external Stripe purchase).
// =====================================================================
function TeamCard({
  team,
  currentUid,
  onPatch,
  onRemove,
  onError,
  onRefresh,
  onClose,
}: {
  team: Team;
  currentUid: string;
  onPatch: (teamId: string, updater: (t: Team) => Team) => void;
  onRemove: (teamId: string) => void;
  onError: (msg: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const ime = useIMEGuard();
  const {
    startCheckout,
    changeTeamSeats,
    assignTeamSeats,
    openBillingPortal,
    billingBusy,
  } = useEntitlementStore();

  const isManager = isTeamManager(team, currentUid);
  const isOwner = team.ownerId === currentUid;
  const active = isTeamBillingActive(team.billing);
  // Byte-for-byte mirror of the server fence gating.ts `deriveSeatAccess`, which
  // clamps seats to Math.max(1, …). Using Math.max(0, …) here would diverge on a
  // corrupt {status:"active", seats:0} doc — the server grants seatAssignments[0]
  // while the client would render that member as over-capacity and "超過分を解除"
  // would strip the very seat the server was honoring. Unreachable via the webhook
  // (active writes always set seats≥1), but we keep the clamps identical so the UI
  // can never disagree with the authoritative fence. The seat UI only renders when
  // `active`, where the real paid count is always ≥1, so this never misrepresents.
  const paidSeats = Math.max(1, Math.floor(Number(team.billing?.seats) || 0));

  // Add-member inline form
  const [adding, setAdding] = useState(false);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"admin" | "member">("member");

  // Purchase form (when NOT yet subscribed)
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [buySeats, setBuySeats] = useState(Math.max(1, nonOwnerCount(team)));

  // Seat-count change (when subscribed)
  const [seatValue, setSeatValue] = useState(Math.max(1, paidSeats));

  // Ordered uid list of who holds a seat (draft, until saved).
  const assignableMembers = team.members.filter(
    (m) => m.role !== "owner" && m.uid,
  );
  const assignableUids = new Set(assignableMembers.map((m) => m.uid));
  const [assignDraft, setAssignDraft] = useState<string[]>(
    (team.seatAssignments ?? []).filter((u) => assignableUids.has(u)),
  );
  const [notice, setNotice] = useState("");

  // Re-sync drafts when the underlying team doc changes (e.g. after a refresh).
  useEffect(() => {
    setSeatValue(Math.max(1, paidSeats));
  }, [paidSeats]);
  // Re-sync the assignment draft from the server list ONLY when the server's
  // assignments ACTUALLY changed (by content, not array identity). onRefresh() and
  // onPatch() hand us a fresh team object on every add-member / seat-count change,
  // whose new seatAssignments array reference would otherwise re-fire this effect
  // and SILENTLY overwrite the manager's unsaved seat toggles (a toggle then an
  // add-member wiped the draft). Comparing derived content preserves an in-progress
  // draft across unrelated refetches while still adopting genuine remote changes.
  const lastSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    const uids = new Set(
      team.members.filter((m) => m.role !== "owner" && m.uid).map((m) => m.uid),
    );
    const serverList = (team.seatAssignments ?? []).filter((u) => uids.has(u));
    const key = serverList.join("|");
    if (key === lastSyncedRef.current) return; // no real server change — keep draft
    lastSyncedRef.current = key;
    setAssignDraft(serverList);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.seatAssignments, team.members]);

  const assignmentsDirty =
    assignDraft.length !== (team.seatAssignments ?? []).length ||
    assignDraft.some((u, i) => u !== (team.seatAssignments ?? [])[i]);

  const handleAddMember = async () => {
    const email = memberEmail.trim();
    if (!email) return;
    onError("");
    try {
      await addTeamMember(team.id, { email, role: memberRole });
      onPatch(team.id, (t) => ({
        ...t,
        members: [
          ...t.members,
          { uid: "", email, role: memberRole, joinedAt: Date.now() },
        ],
      }));
      setMemberEmail("");
      setAdding(false);
      // A freshly added member with a real uid may need a teamSeats reverse-index
      // entry to spend the pool — that requires the manager to assign them a seat.
      onRefresh();
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "メンバーの追加に失敗しました",
      );
    }
  };

  const handleRemoveMember = async (member: TeamMember) => {
    onError("");
    try {
      await removeTeamMember(team.id, member);
      onPatch(team.id, (t) => ({
        ...t,
        members: t.members.filter(
          (m) => m.email !== member.email || m.joinedAt !== member.joinedAt,
        ),
      }));
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "メンバーの削除に失敗しました",
      );
    }
  };

  const handleDeleteTeam = async () => {
    onError("");
    try {
      await deleteTeam(team.id);
      onRemove(team.id);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "チームの削除に失敗しました",
      );
    }
  };

  const handleBuy = async () => {
    setNotice("");
    onError("");
    await startCheckout("team", interval, { teamId: team.id, seats: buySeats });
    // startCheckout surfaces its own error into the store's billingError; mirror
    // it here so a failure is visible inside THIS dialog (billingError renders in
    // the paywall only). On failure the dialog stays up so the user can retry.
    const be = useEntitlementStore.getState().billingError;
    if (be) {
      onError(be);
      return;
    }
    // On a CONFIRMED open, close the dialog (mirrors PaywallDialog, which drops
    // paywallOpen on success). This closes the double-submit window: the buy
    // button briefly re-enables when billingBusy resets, and a second tap during
    // the webhook-lag window could open a duplicate Checkout (→ duplicate team
    // subscription / double charge). The external Checkout browser is already
    // open; the billing-return handler polls the entitlement. The buyer reopens
    // team management afterward to assign seats.
    onClose();
  };

  const handleChangeSeats = async () => {
    setNotice("");
    onError("");
    const res = await changeTeamSeats(team.id, seatValue);
    if (!res.ok) {
      onError(res.error || "席数の変更に失敗しました");
      return;
    }
    const newSeats = res.seats ?? seatValue;
    // Reducing the paid count below the number of assigned members means the
    // trailing members (past the ordered fence) lose pool access on the SERVER
    // immediately (deriveSeatAccess denies indices >= seats), even though
    // seatAssignments is untouched. Warn explicitly — a silent seat reduction
    // that quietly cuts members off would be a support nightmare.
    const overflow = Math.max(0, assignDraft.length - newSeats);
    setNotice(
      `席数を ${newSeats} に変更しました。反映まで数秒かかることがあります。` +
        (overflow > 0
          ? ` 現在 ${assignDraft.length} 名を割り当て済みのため、下位 ${overflow} 名がAIプールを利用できなくなります。「席の割り当て」を見直してください。`
          : ""),
    );
    // The webhook reconciles teams/{id}.billing.seats; pull the fresh doc shortly.
    onRefresh();
  };

  const toggleAssign = (uid: string) => {
    setAssignDraft((prev) => {
      if (prev.includes(uid)) return prev.filter((u) => u !== uid);
      if (prev.length >= paidSeats) return prev; // at capacity — can't add more
      return [...prev, uid];
    });
  };

  const handleSaveAssignments = async () => {
    setNotice("");
    onError("");
    const res = await assignTeamSeats(team.id, assignDraft);
    if (!res.ok) {
      onError(res.error || "席の割り当てに失敗しました");
      return;
    }
    const saved = res.seatAssignments ?? assignDraft;
    onPatch(team.id, (t) => ({ ...t, seatAssignments: saved }));
    setNotice("席の割り当てを保存しました。");
  };

  // Assignment order is the SERVER capacity fence (deriveSeatAccess grants only
  // indices 0…seats-1). Anyone past `paidSeats` in the ordered draft is assigned
  // but has NO access — surface that instead of showing a green "席あり" for them.
  const overCapacityCount = Math.max(0, assignDraft.length - paidSeats);
  // Explicit trim to the funded seats (drops the trailing over-capacity uids,
  // keeping the in-fence ones). Must still be saved to persist.
  const trimOverCapacity = () =>
    setAssignDraft((prev) => prev.slice(0, Math.max(0, paidSeats)));

  const total = perMonth("team", interval) * Math.max(1, buySeats);

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate font-medium text-sm">{team.name}</span>
          {active && (
            <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
              Teamプラン ・ {paidSeats}席
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isManager && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => {
                setAdding((v) => !v);
                setMemberEmail("");
              }}
              title="メンバーを追加"
            >
              <UserPlus className="h-3 w-3" />
            </Button>
          )}
          {isOwner && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              onClick={handleDeleteTeam}
              title="チームを削除"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Add member inline */}
      {adding && isManager && (
        <div className="flex gap-1.5">
          <Input
            autoFocus
            placeholder="メールアドレス"
            value={memberEmail}
            onChange={(e) => setMemberEmail(e.target.value)}
            className="text-xs h-7"
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(e) => {
              if (!ime.isComposing() && e.key === "Enter") handleAddMember();
            }}
          />
          <select
            className="rounded-md border border-input bg-background px-1.5 text-[10px] h-7"
            value={memberRole}
            onChange={(e) =>
              setMemberRole(e.target.value as "admin" | "member")
            }
          >
            <option value="member">メンバー</option>
            <option value="admin">管理者</option>
          </select>
          <Button
            size="sm"
            className="h-7 text-xs shrink-0"
            onClick={handleAddMember}
            disabled={!memberEmail.trim()}
          >
            追加
          </Button>
        </div>
      )}

      {/* Members */}
      <div className="space-y-0.5">
        {team.members.map((m, i) => {
          // Ordered fence: a uid has REAL access only at draft index < paidSeats;
          // anyone assigned beyond that is "over capacity" (assigned, no access).
          const seatIdx = m.uid ? assignDraft.indexOf(m.uid) : -1;
          const seatHeld = seatIdx >= 0;
          const hasAccess = seatHeld && seatIdx < paidSeats;
          const overCapacity = seatHeld && seatIdx >= paidSeats;
          const atCapacity = assignDraft.length >= paidSeats;
          const canToggle =
            active && isManager && !!m.uid && m.role !== "owner";
          return (
            <div
              key={`${m.email}-${i}`}
              className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-accent/50"
            >
              <div className="flex items-center gap-2 min-w-0">
                {roleIcon(m.role)}
                <span className="truncate">{m.email}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {m.role === "owner"
                    ? "オーナー"
                    : m.role === "admin"
                      ? "管理者"
                      : "メンバー"}
                </span>
                {active && m.role === "owner" && (
                  <span className="text-[10px] text-emerald-600 shrink-0">
                    常にアクセス可
                  </span>
                )}
                {active && m.role !== "owner" && !m.uid && (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    サインイン待ち
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {canToggle && (
                  <button
                    type="button"
                    onClick={() => toggleAssign(m.uid)}
                    disabled={billingBusy || (!seatHeld && atCapacity)}
                    className={cn(
                      "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors disabled:opacity-40",
                      hasAccess
                        ? "bg-emerald-500/10 text-emerald-600"
                        : overCapacity
                          ? "bg-destructive/10 text-destructive"
                          : "border border-border text-muted-foreground hover:text-foreground",
                    )}
                    title={
                      hasAccess
                        ? "席を解除"
                        : overCapacity
                          ? "席数の上限を超えています（アクセス不可）。押すと解除します"
                          : "席を割り当て"
                    }
                  >
                    {hasAccess && <Check className="h-2.5 w-2.5" />}
                    {hasAccess
                      ? "席あり"
                      : overCapacity
                        ? "超過・アクセス不可"
                        : "席を割り当て"}
                  </button>
                )}
                {m.role !== "owner" && isManager && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={() => handleRemoveMember(m)}
                    title="メンバーを削除"
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Seat assignment save (only when subscribed + manager) */}
      {active && isManager && (
        <div className="space-y-1 pt-1">
          {overCapacityCount > 0 && (
            <p className="text-[10px] text-destructive">
              席数（{paidSeats}）を超えて {overCapacityCount}{" "}
              名が割り当てられています。上位から{paidSeats}
              名のみがAIプールを利用でき、超過分は利用できません。順序を見直すか超過分を解除してください。
            </p>
          )}
          <div className="flex items-center justify-between">
            <span
              className={cn(
                "text-[10px]",
                assignDraft.length > paidSeats
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {assignDraft.length} / {paidSeats} 席を割り当て済み
            </span>
            <div className="flex items-center gap-1.5">
              {overCapacityCount > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px] text-destructive"
                  disabled={billingBusy}
                  onClick={trimOverCapacity}
                >
                  超過分を解除
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px]"
                disabled={!assignmentsDirty || billingBusy}
                onClick={handleSaveAssignments}
              >
                {billingBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "割り当てを保存"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Billing block (manager only) */}
      {isManager && (
        <>
          <Separator />
          {!active ? (
            // ── Not subscribed: buy a Team subscription ──────────────────
            BILLING_ENABLED ? (
              isMobile ? (
                <p className="text-[11px] text-muted-foreground">
                  Teamプランのご購入はデスクトップ版またはWebから行えます。
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">
                      Teamプランを購入
                    </span>
                    <div className="inline-flex rounded-md border border-border p-0.5 text-[10px]">
                      <button
                        className={cn(
                          "rounded px-2 py-0.5 transition-colors",
                          interval === "month"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground",
                        )}
                        onClick={() => setInterval("month")}
                      >
                        月払い
                      </button>
                      <button
                        className={cn(
                          "rounded px-2 py-0.5 transition-colors",
                          interval === "year"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground",
                        )}
                        onClick={() => setInterval("year")}
                      >
                        年払い
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-muted-foreground">
                      席数
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={MAX_TEAM_SEATS}
                      value={buySeats}
                      onChange={(e) =>
                        setBuySeats(
                          Math.min(
                            MAX_TEAM_SEATS,
                            Math.max(
                              1,
                              Math.floor(Number(e.target.value) || 1),
                            ),
                          ),
                        )
                      }
                      className="h-7 w-20 text-xs"
                    />
                    <span className="text-[11px] text-muted-foreground">
                      合計 {yen(total)}/月
                      {interval === "year" && "（年払い）"}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    className="h-8 w-full text-xs"
                    disabled={billingBusy}
                    onClick={handleBuy}
                  >
                    {billingBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      `${buySeats}席で購入（${yen(total)}/月）`
                    )}
                  </Button>
                  <p className="text-[10px] text-muted-foreground">
                    お支払いはStripeの安全な決済ページで行われます。オーナーは常にアクセスでき、購入後にメンバーへ席を割り当てられます。
                  </p>
                </div>
              )
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Teamプランは近日対応予定です。
              </p>
            )
          ) : (
            // ── Subscribed: change seat count / manage subscription ──────
            <div className="space-y-2">
              {!isMobile && BILLING_ENABLED && (
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-muted-foreground">
                    席数を変更
                  </label>
                  <Input
                    type="number"
                    min={1}
                    max={MAX_TEAM_SEATS}
                    value={seatValue}
                    onChange={(e) =>
                      setSeatValue(
                        Math.min(
                          MAX_TEAM_SEATS,
                          Math.max(1, Math.floor(Number(e.target.value) || 1)),
                        ),
                      )
                    }
                    className="h-7 w-20 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={billingBusy || seatValue === paidSeats}
                    onClick={handleChangeSeats}
                  >
                    {billingBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "変更"
                    )}
                  </Button>
                </div>
              )}
              {/* Anti-steering: portal is web/desktop only. */}
              {isOwner && !isMobile && BILLING_ENABLED && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 text-[11px]"
                  disabled={billingBusy}
                  onClick={async () => {
                    const r = await openBillingPortal();
                    if (!r.ok && r.error) onError(r.error);
                  }}
                >
                  <CreditCard className="h-3 w-3" />
                  契約を管理（支払い方法・解約）
                </Button>
              )}
              {isMobile && (
                <p className="text-[11px] text-muted-foreground">
                  席数の変更・解約はデスクトップ版またはWebから行えます。
                </p>
              )}
            </div>
          )}
        </>
      )}

      {notice && <p className="text-[11px] text-emerald-600">{notice}</p>}
    </div>
  );
}

export function TeamManageDialog({
  open,
  onOpenChange,
}: TeamManageDialogProps) {
  const { user } = useAuthStore();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const ime = useIMEGuard();

  const [newTeamName, setNewTeamName] = useState("");
  const [creating, setCreating] = useState(false);

  const loadTeams = () => {
    if (!user) return;
    setLoading(true);
    fetchUserTeams(user.uid)
      .then(setTeams)
      .catch(() => setError("チームの読み込みに失敗しました"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open || !user) return;
    loadTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user]);

  const handleCreateTeam = async () => {
    if (!user || !newTeamName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const id = await createTeam(newTeamName.trim(), {
        uid: user.uid,
        email: user.email || "",
      });
      setTeams((prev) => [
        ...prev,
        {
          id,
          name: newTeamName.trim(),
          ownerId: user.uid,
          memberUids: [user.uid],
          members: [
            {
              uid: user.uid,
              email: user.email || "",
              role: "owner",
              joinedAt: Date.now(),
            },
          ],
          createdAt: null,
        },
      ]);
      setNewTeamName("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "チームの作成に失敗しました",
      );
    } finally {
      setCreating(false);
    }
  };

  const patchTeam = (teamId: string, updater: (t: Team) => Team) =>
    setTeams((prev) => prev.map((t) => (t.id === teamId ? updater(t) : t)));
  const removeTeam = (teamId: string) =>
    setTeams((prev) => prev.filter((t) => t.id !== teamId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            チーム管理
          </DialogTitle>
          <DialogDescription>
            チームを作成し、メンバーの管理・Teamプランの席の割り当てを行えます。
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Create team */}
        <div className="flex gap-2">
          <Input
            placeholder="新しいチーム名"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            className="text-xs"
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(e) => {
              if (!ime.isComposing() && e.key === "Enter") handleCreateTeam();
            }}
          />
          <Button
            size="sm"
            className="h-9 shrink-0 gap-1.5"
            onClick={handleCreateTeam}
            disabled={creating || !newTeamName.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
            作成
          </Button>
        </div>

        <Separator />

        {/* Teams list */}
        <ScrollArea className="max-h-[420px]">
          {loading ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              読み込み中…
            </p>
          ) : teams.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              まだチームがありません。作成して始めましょう。
            </p>
          ) : (
            <div className="space-y-3">
              {teams.map((team) => (
                <TeamCard
                  key={team.id}
                  team={team}
                  currentUid={user?.uid ?? ""}
                  onPatch={patchTeam}
                  onRemove={removeTeam}
                  onError={setError}
                  onRefresh={loadTeams}
                  onClose={() => onOpenChange(false)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
