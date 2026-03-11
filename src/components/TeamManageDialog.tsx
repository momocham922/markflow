import { useState, useEffect } from "react";
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
import { Users, Plus, Trash2, UserPlus, Crown, Shield, User } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import {
  createTeam,
  fetchUserTeams,
  addTeamMember,
  removeTeamMember,
  deleteTeam,
  type Team,
  type TeamMember,
} from "@/services/sharing";

interface TeamManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TeamManageDialog({ open, onOpenChange }: TeamManageDialogProps) {
  const { user } = useAuthStore();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Create team
  const [newTeamName, setNewTeamName] = useState("");
  const [creating, setCreating] = useState(false);

  // Add member
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"admin" | "member">("member");
  const ime = useIMEGuard();

  useEffect(() => {
    if (!open || !user) return;
    setLoading(true);
    fetchUserTeams(user.uid)
      .then(setTeams)
      .catch(() => setError("Failed to load teams"))
      .finally(() => setLoading(false));
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
      setError(err instanceof Error ? err.message : "Failed to create team");
    } finally {
      setCreating(false);
    }
  };

  const handleAddMember = async (teamId: string) => {
    if (!memberEmail.trim()) return;
    setError("");
    try {
      await addTeamMember(teamId, { email: memberEmail.trim(), role: memberRole });
      setTeams((prev) =>
        prev.map((t) =>
          t.id === teamId
            ? {
                ...t,
                members: [
                  ...t.members,
                  { uid: "", email: memberEmail.trim(), role: memberRole, joinedAt: Date.now() },
                ],
              }
            : t,
        ),
      );
      setMemberEmail("");
      setAddingTo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
    }
  };

  const handleRemoveMember = async (teamId: string, member: TeamMember) => {
    setError("");
    try {
      await removeTeamMember(teamId, member);
      setTeams((prev) =>
        prev.map((t) =>
          t.id === teamId
            ? { ...t, members: t.members.filter((m) => m.email !== member.email || m.joinedAt !== member.joinedAt) }
            : t,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    }
  };

  const handleDeleteTeam = async (teamId: string) => {
    setError("");
    try {
      await deleteTeam(teamId);
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete team");
    }
  };

  const roleIcon = (role: string) => {
    if (role === "owner") return <Crown className="h-3 w-3 text-amber-500" />;
    if (role === "admin") return <Shield className="h-3 w-3 text-blue-500" />;
    return <User className="h-3 w-3 text-muted-foreground" />;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Manage Teams
          </DialogTitle>
          <DialogDescription>
            Create teams and manage members for easy document sharing
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Create team */}
        <div className="flex gap-2">
          <Input
            placeholder="New team name"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            className="text-xs"
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(e) => { if (!ime.isComposing() && e.key === "Enter") handleCreateTeam(); }}
          />
          <Button
            size="sm"
            className="h-9 shrink-0 gap-1.5"
            onClick={handleCreateTeam}
            disabled={creating || !newTeamName.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
            Create
          </Button>
        </div>

        <Separator />

        {/* Teams list */}
        <ScrollArea className="max-h-[350px]">
          {loading ? (
            <p className="text-xs text-muted-foreground text-center py-4">Loading...</p>
          ) : teams.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No teams yet. Create one to get started.
            </p>
          ) : (
            <div className="space-y-3">
              {teams.map((team) => (
                <div key={team.id} className="rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-sm">{team.name}</div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => {
                          setAddingTo(addingTo === team.id ? null : team.id);
                          setMemberEmail("");
                        }}
                        title="Add member"
                      >
                        <UserPlus className="h-3 w-3" />
                      </Button>
                      {team.ownerId === user?.uid && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteTeam(team.id)}
                          title="Delete team"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Add member inline */}
                  {addingTo === team.id && (
                    <div className="flex gap-1.5">
                      <Input
                        autoFocus
                        placeholder="Email"
                        value={memberEmail}
                        onChange={(e) => setMemberEmail(e.target.value)}
                        className="text-xs h-7"
                        onCompositionStart={ime.onCompositionStart}
                        onCompositionEnd={ime.onCompositionEnd}
                        onKeyDown={(e) => { if (!ime.isComposing() && e.key === "Enter") handleAddMember(team.id); }}
                      />
                      <select
                        className="rounded-md border border-input bg-background px-1.5 text-[10px] h-7"
                        value={memberRole}
                        onChange={(e) => setMemberRole(e.target.value as "admin" | "member")}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                      <Button
                        size="sm"
                        className="h-7 text-xs shrink-0"
                        onClick={() => handleAddMember(team.id)}
                        disabled={!memberEmail.trim()}
                      >
                        Add
                      </Button>
                    </div>
                  )}

                  {/* Members */}
                  <div className="space-y-0.5">
                    {team.members.map((m, i) => (
                      <div
                        key={`${m.email}-${i}`}
                        className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-accent/50"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {roleIcon(m.role)}
                          <span className="truncate">{m.email}</span>
                          <span className="text-[10px] text-muted-foreground capitalize shrink-0">
                            {m.role}
                          </span>
                        </div>
                        {m.role !== "owner" && team.ownerId === user?.uid && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 shrink-0"
                            onClick={() => handleRemoveMember(team.id, m)}
                          >
                            <Trash2 className="h-2.5 w-2.5" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
