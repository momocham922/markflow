import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Send,
  Link,
  Copy,
  Check,
  Globe,
  Lock,
  Users,
  UserPlus,
  X,
  Bell,
  Settings,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import {
  enableShareLink,
  disableShareLink,
  addCollaborator,
  removeCollaborator,
  getCollaborators,
  type ShareLink,
  type Collaborator,
} from "@/services/sharing";
import { fetchDocument, saveDocumentToFirestore } from "@/services/firebase";
import {
  loadSlackNotifyConfig,
  saveSlackNotifyConfig,
  notifySlack,
  type SlackNotifyConfig,
} from "@/services/slack-notify";

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Tab = "link" | "people" | "notifications";

export function ShareDialog({ open, onOpenChange }: ShareDialogProps) {
  const { activeDocId, documents } = useAppStore();
  const { user } = useAuthStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);

  const [tab, setTab] = useState<Tab>("link");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  // Share link state
  const [shareLink, setShareLink] = useState<ShareLink | null>(null);
  const [linkPermission, setLinkPermission] = useState<"view" | "edit">("view");
  const [linkLoading, setLinkLoading] = useState(false);

  // Collaborators state
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("viewer");
  const [inviting, setInviting] = useState(false);

  // Slack notifications state
  const [slackConfig, setSlackConfig] = useState<SlackNotifyConfig>({
    webhookUrl: "",
    channel: "",
    enabled: false,
    events: { onEdit: true, onShare: true, onComment: true },
  });
  const [slackSaved, setSlackSaved] = useState(false);

  // Load existing share data when dialog opens
  useEffect(() => {
    if (!open || !activeDocId || !user) return;

    // Load share link from Firestore
    fetchDocument(activeDocId)
      .then((doc) => {
        if (doc?.shareLink) {
          setShareLink(doc.shareLink as ShareLink);
          setLinkPermission(doc.shareLink.permission);
        } else {
          setShareLink(null);
        }
      })
      .catch(() => {});

    // Load collaborators (map → array)
    getCollaborators(activeDocId).then(setCollaborators).catch(() => {});

    // Load Slack config
    loadSlackNotifyConfig().then(setSlackConfig).catch(() => {});
  }, [open, activeDocId, user]);

  const getShareUrl = useCallback(
    (token: string) => {
      const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
      if (projectId) {
        return `https://${projectId}.web.app/share/${token}`;
      }
      return `markflow://share/${token}`;
    },
    [],
  );

  // ─── Share Link handlers ──────────────────────────────

  const handleEnableLink = async () => {
    if (!activeDocId || !user) return;
    setLinkLoading(true);
    setError("");
    try {
      // Ensure latest content is synced to Firestore before sharing
      if (activeDoc) {
        const { saveDocumentToFirestore } = await import("@/services/firebase");
        await saveDocumentToFirestore({
          id: activeDoc.id,
          title: activeDoc.title,
          content: activeDoc.content,
          ownerId: user.uid,
          folder: activeDoc.folder,
          tags: activeDoc.tags,
        });
      }
      const link = await enableShareLink(activeDocId, linkPermission);
      setShareLink(link);

      // Notify Slack
      notifySlack("share", {
        docTitle: activeDoc?.title || "Untitled",
        authorName: user?.displayName || user?.email || undefined,
        shareUrl: getShareUrl(link.token),
        detail: `Shared with ${linkPermission} access via link`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create link");
    } finally {
      setLinkLoading(false);
    }
  };

  const handleDisableLink = async () => {
    if (!activeDocId) return;
    setLinkLoading(true);
    try {
      await disableShareLink(activeDocId);
      setShareLink((prev) => (prev ? { ...prev, enabled: false } : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable link");
    } finally {
      setLinkLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!shareLink?.token) return;
    const url = getShareUrl(shareLink.token);
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePermissionChange = async (perm: "view" | "edit") => {
    setLinkPermission(perm);
    if (shareLink?.enabled && activeDocId) {
      try {
        const link = await enableShareLink(activeDocId, perm);
        setShareLink(link);
      } catch { /* ignore */ }
    }
  };

  // ─── Collaborator handlers ────────────────────────────

  const handleInvite = async () => {
    if (!activeDocId || !inviteEmail.trim()) return;
    setInviting(true);
    setError("");
    try {
      // Save current content to Firestore before sharing — ensures
      // the collaborator gets the latest content, not a stale version.
      if (activeDoc) {
        await saveDocumentToFirestore({
          id: activeDocId,
          title: activeDoc.title,
          content: activeDoc.content,
          ownerId: activeDoc.ownerId || user?.uid || "",
          folder: activeDoc.folder,
          tags: activeDoc.tags,
        });
      }
      await addCollaborator(activeDocId, inviteEmail.trim(), inviteRole);
      setCollaborators((prev) => [
        ...prev,
        { uid: "", email: inviteEmail.trim(), role: inviteRole, addedAt: Date.now() },
      ]);
      setInviteEmail("");

      // Notify Slack
      notifySlack("share", {
        docTitle: activeDoc?.title || "Untitled",
        authorName: user?.displayName || user?.email || undefined,
        detail: `Invited ${inviteEmail.trim()} as ${inviteRole}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveCollab = async (collab: Collaborator) => {
    if (!activeDocId) return;
    try {
      await removeCollaborator(activeDocId, collab);
      setCollaborators((prev) => prev.filter((c) => c.email !== collab.email));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove");
    }
  };

  // ─── Slack notification handlers ──────────────────────

  const handleSaveSlackConfig = async () => {
    try {
      await saveSlackNotifyConfig(slackConfig);
      setSlackSaved(true);
      setTimeout(() => setSlackSaved(false), 2000);
    } catch {
      setError("Failed to save notification settings");
    }
  };

  // ─── Copy text ────────────────────────────────────────

  const handleCopyText = async () => {
    if (!activeDoc) return;
    const parser = new DOMParser();
    const parsed = parser.parseFromString(activeDoc.content, "text/html");
    await navigator.clipboard.writeText(parsed.body.textContent || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!user) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Share Document</DialogTitle>
            <DialogDescription>Log in to share documents</DialogDescription>
          </DialogHeader>
          <div className="py-6 text-center text-sm text-muted-foreground">
            <p>Sign in to enable sharing, collaboration, and notifications.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 gap-2"
              onClick={handleCopyText}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy as Text
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Share "{activeDoc?.title || "Untitled"}"
          </DialogTitle>
          <DialogDescription>
            Manage access, invite collaborators, and set up notifications
          </DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex border-b border-border">
          {(
            [
              { id: "link", icon: Link, label: "Link" },
              { id: "people", icon: Users, label: "People" },
              { id: "notifications", icon: Bell, label: "Notifications" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                tab === t.id
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab(t.id)}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {error && (
          <p className="text-xs text-destructive px-1">{error}</p>
        )}

        {/* ─── Link tab ─── */}
        {tab === "link" && (
          <div className="space-y-4 py-2">
            {/* Quick copy */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-2"
                onClick={handleCopyText}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy Text
              </Button>
            </div>

            <Separator />

            {/* Share link toggle */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs flex items-center gap-1.5">
                  {shareLink?.enabled ? (
                    <Globe className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Lock className="h-3.5 w-3.5" />
                  )}
                  Share Link
                </Label>
                <div className="flex items-center gap-2">
                  {/* Permission selector */}
                  <select
                    className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                    value={linkPermission}
                    onChange={(e) => handlePermissionChange(e.target.value as "view" | "edit")}
                  >
                    <option value="view">Can view</option>
                    <option value="edit">Can edit</option>
                  </select>
                  {shareLink?.enabled ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleDisableLink}
                      disabled={linkLoading}
                    >
                      Disable
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleEnableLink}
                      disabled={linkLoading}
                    >
                      {linkLoading ? "Creating..." : "Create Link"}
                    </Button>
                  )}
                </div>
              </div>

              {shareLink?.enabled && (
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={getShareUrl(shareLink.token)}
                    className="text-xs font-mono"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={handleCopyLink}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              )}

              {shareLink?.enabled && (
                <p className="text-[10px] text-muted-foreground">
                  Anyone with this link can {linkPermission === "edit" ? "edit" : "view"} this
                  document.
                  {shareLink.expiresAt && (
                    <> Expires {new Date(shareLink.expiresAt).toLocaleDateString()}.</>
                  )}
                </p>
              )}
            </div>
          </div>
        )}

        {/* ─── People tab ─── */}
        {tab === "people" && (
          <div className="space-y-4 py-2">
            {/* Invite by email */}
            <div className="space-y-2">
              <Label className="text-xs flex items-center gap-1.5">
                <UserPlus className="h-3.5 w-3.5" />
                Invite People
              </Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Email address"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="text-xs"
                  onKeyDown={(e) => { if (!e.nativeEvent.isComposing && e.key === "Enter") handleInvite(); }}
                />
                <select
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as "editor" | "viewer")}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <Button
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={handleInvite}
                  disabled={inviting || !inviteEmail.trim()}
                >
                  {inviting ? "..." : "Invite"}
                </Button>
              </div>
            </div>

            <Separator />

            {/* Current collaborators */}
            <div className="space-y-2">
              <Label className="text-xs">
                Collaborators ({collaborators.length})
              </Label>
              <ScrollArea className="max-h-[200px]">
                {collaborators.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">
                    No collaborators yet
                  </p>
                ) : (
                  <div className="space-y-1">
                    {collaborators.map((c, i) => (
                      <div
                        key={`${c.email}-${i}`}
                        className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-accent/50"
                      >
                        <div className="min-w-0">
                          <div className="text-xs truncate">{c.email}</div>
                          <div className="text-[10px] text-muted-foreground capitalize">
                            {c.role}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={() => handleRemoveCollab(c)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
          </div>
        )}

        {/* ─── Notifications tab ─── */}
        {tab === "notifications" && (
          <div className="space-y-4 py-2">
            <div className="space-y-3">
              <Label className="text-xs flex items-center gap-1.5">
                <Settings className="h-3.5 w-3.5" />
                Slack Notifications
              </Label>
              <p className="text-[10px] text-muted-foreground">
                Get notified in Slack when documents are edited or shared.
              </p>

              <div className="space-y-2">
                <Input
                  placeholder="Slack Webhook URL"
                  value={slackConfig.webhookUrl}
                  onChange={(e) =>
                    setSlackConfig((c) => ({ ...c, webhookUrl: e.target.value }))
                  }
                  className="text-xs font-mono"
                  type="url"
                />
                <Input
                  placeholder="#channel (optional)"
                  value={slackConfig.channel || ""}
                  onChange={(e) =>
                    setSlackConfig((c) => ({ ...c, channel: e.target.value }))
                  }
                  className="text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-[10px] text-muted-foreground">Notify on:</Label>
                {(
                  [
                    { key: "onEdit", label: "Document edits" },
                    { key: "onShare", label: "Sharing changes" },
                  ] as const
                ).map(({ key, label }) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={slackConfig.events[key]}
                      onChange={(e) =>
                        setSlackConfig((c) => ({
                          ...c,
                          events: { ...c.events, [key]: e.target.checked },
                        }))
                      }
                      className="rounded"
                    />
                    {label}
                  </label>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={slackConfig.enabled}
                    onChange={(e) =>
                      setSlackConfig((c) => ({ ...c, enabled: e.target.checked }))
                    }
                    className="rounded"
                  />
                  Enable notifications
                </label>
              </div>

              <Button
                size="sm"
                className="w-full gap-2"
                onClick={handleSaveSlackConfig}
                disabled={!slackConfig.webhookUrl}
              >
                {slackSaved ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Saved!
                  </>
                ) : (
                  <>
                    <Bell className="h-3.5 w-3.5" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
