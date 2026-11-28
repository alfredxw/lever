import { lazy, Suspense } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { bindMobileNodeRequests, queryClient } from "@/api/client";
import { createRoot } from "react-dom/client";
import { isMyGo } from "mygo-runtime";
import { HubApp } from "./HubApp";
import { browserTransport, mobileTransport } from "./client";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/i18n";
import "@/index.css";
import "./hub.css";

const Standalone = lazy(()=>import("@/features/nodes/StandaloneWorkspace").then(m=>({default:m.StandaloneWorkspace})));

if(isMyGo()) bindMobileNodeRequests(mobileTransport.request);

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {location.pathname==="/workspace"?
      <QueryClientProvider client={queryClient}><Suspense fallback={null}><Standalone/></Suspense></QueryClientProvider>:
      <HubApp transport={isMyGo() ? mobileTransport : browserTransport} />}
  </TooltipProvider>,
);
