import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const shortcuts = [
  { category: "General", items: [
    { keys: "Cmd+K", desc: "Command palette" },
    { keys: "Cmd+Shift+/", desc: "Keyboard shortcuts" },
    { keys: "Cmd+P", desc: "Print / Export PDF" },
  ]},
  { category: "Formatting", items: [
    { keys: "Cmd+B", desc: "Bold" },
    { keys: "Cmd+I", desc: "Italic" },
    { keys: "Cmd+E", desc: "Inline code" },
    { keys: "Cmd+Shift+X", desc: "Strikethrough" },
    { keys: "Cmd+Shift+K", desc: "Wiki link [[]]" },
    { keys: "Cmd+Shift+C", desc: "Code block" },
  ]},
  { category: "Headings", items: [
    { keys: "Cmd+Shift+1", desc: "Heading 1" },
    { keys: "Cmd+Shift+2", desc: "Heading 2" },
    { keys: "Cmd+Shift+3", desc: "Heading 3" },
  ]},
  { category: "Lists & Blocks", items: [
    { keys: "Cmd+Shift+8", desc: "Bullet list" },
    { keys: "Cmd+Shift+7", desc: "Numbered list" },
    { keys: "Cmd+Shift+.", desc: "Blockquote" },
  ]},
];

export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Available keyboard shortcuts in MarkFlow
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {shortcuts.map((group) => (
            <div key={group.category}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {group.category}
              </h3>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <div
                    key={item.keys}
                    className="flex items-center justify-between py-1 px-2 rounded hover:bg-accent/50"
                  >
                    <span className="text-sm">{item.desc}</span>
                    <kbd className="inline-flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                      {item.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
