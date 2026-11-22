import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { isMyGo, runtime } from "mygo-runtime";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { queryClient, pair } from "@/api/client";
import { ErrorNotice } from "@/components/common";
import { events } from "@/api/desktop.gen";
import App from "./App";
import { PreferencesProvider } from "@/features/settings/Preferences";
import { StandaloneHtmlPreview } from "@/features/chat/HtmlPreview";
import "./index.css";
import "./desktop.css";

const desktop = isMyGo() ? runtime() : undefined;
const platform = desktop?.platform;
if (platform) document.documentElement.dataset.desktopPlatform = platform;
if (desktop)
  events.leverDesktopFrame.on(({ height, left, right }) => {
    const root = document.documentElement;
    root.style.setProperty("--mygo-titlebar-height", height + "px");
    root.style.setProperty("--mygo-titlebar-inset-left", left + "px");
    root.style.setProperty("--mygo-titlebar-inset-right", right + "px");
    root.dispatchEvent(new Event("lever-frame"));
  });

function DesktopFrame({ children }: { children: React.ReactNode }) {
  return platform === "win32" ? (
    <div className="desktop-shell">
      <header className="desktop-titlebar">Lever</header>
      {children}
    </div>
  ) : (
    children
  );
}

function Notifications() {
  const { t } = useTranslation();
  return (
    <Toaster
      position="top-right"
      offset={{ top: 52, right: 16 }}
      toastOptions={{ className: "notification-surface" }}
      containerAriaLabel={t("common.notifications")}
    />
  );
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
const previewPage = location.pathname.startsWith("/view/");
(previewPage ? Promise.resolve() : pair())
  .then(() =>
    root.render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          {previewPage ? (
            <StandaloneHtmlPreview />
          ) : (
            <>
              <DesktopFrame>
                <PreferencesProvider>
                  <App />
                </PreferencesProvider>
              </DesktopFrame>
              <Notifications />
            </>
          )}
        </QueryClientProvider>
      </React.StrictMode>,
    ),
  )
  .catch((error) =>
    root.render(
      <div className="p-8">
        <ErrorNotice error={error} />
        <p>{i18n.t("error.pair")}</p>
      </div>,
    ),
  );
