import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Editor } from "@/components/editor/Editor";
import { StatusBar } from "@/components/StatusBar";
import { useAppStore } from "@/stores/app-store";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function App() {
  const { sidebarOpen, toggleSidebar, theme } = useAppStore();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <div
            className={cn(
              "shrink-0 transition-all duration-200",
              sidebarOpen ? "w-60" : "w-0",
            )}
          >
            {sidebarOpen && <Sidebar />}
          </div>

          {/* Main content */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Show sidebar toggle when collapsed */}
            {!sidebarOpen && (
              <div className="flex items-center border-b border-border px-2 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={toggleSidebar}
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </div>
            )}
            <div className="flex-1 overflow-hidden">
              <Editor />
            </div>
          </div>
        </div>

        <StatusBar />
      </div>
    </TooltipProvider>
  );
}

export default App;
