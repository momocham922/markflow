# MarkFlow

Cross-platform Markdown editor built with Tauri v2 + React 19 + TypeScript.

## Development

```bash
pnpm install
pnpm tauri dev    # Start dev server with Tauri window
pnpm dev          # Frontend only dev server (port 1420)
pnpm build        # Build frontend
pnpm tauri build  # Full production build
```

## Tech Stack
- **Desktop shell**: Tauri v2 (Rust)
- **Frontend**: React 19 + TypeScript + Vite
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Editor**: Tiptap v2 (ProseMirror)
- **State**: Zustand

## Project Structure
- `src/` - React frontend
- `src-tauri/` - Rust Tauri backend
- `src/components/editor/` - Tiptap editor components
- `src/components/sidebar/` - File sidebar
- `src/stores/` - Zustand state stores
- `src/styles/` - Global CSS
