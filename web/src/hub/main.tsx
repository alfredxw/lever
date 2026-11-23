import { createRoot } from "react-dom/client";
import { isMyGo } from "mygo-runtime";
import { HubApp } from "./HubApp";
import { browserTransport, mobileTransport } from "./client";
import "@/index.css";
import "./hub.css";

createRoot(document.getElementById("root")!).render(
  <HubApp transport={isMyGo() ? mobileTransport : browserTransport} />,
);
