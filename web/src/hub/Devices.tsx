import { useState } from "react";
import { call } from "mygo-runtime";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Device, PushSettings } from "@/api/hub.gen";
import { deviceLink } from "./client";
import { deviceStatus, type Workspace } from "./HubApp";

export function Devices({
  ws,
  devices,
  logout,
  browser,
  ownDevice,
}: {
  ws: Workspace;
  devices: Device[];
  logout: () => void;
  browser: boolean;
  ownDevice: string;
}) {
  const [role, setRole] = useState("controller");
  const [ticket, setTicket] = useState<{ code: string; expires: number }>();
  const sessions = useQuery({
    queryKey: [ws.key, "sessions"],
    enabled: browser,
    queryFn: () =>
      ws.transport.request<
        { id: string; agent: string; current: boolean; expires: number }[]
      >("/api/sessions"),
  });
  const push = useQuery({
    queryKey: [ws.key, "push"],
    enabled: ws.transport.kind === "mobile",
    queryFn: () => ws.transport.request<PushSettings>(ws.path + "/push"),
  });
  return (
    <>
      <h1>设备</h1>
      {ws.transport.kind === "mobile" && (
        <section className="hub-group">
          <label className="hub-check">
            <Switch
              aria-label="锁屏通知"
              checked={push.data?.enabled ?? false}
              disabled={
                !push.data || (!push.data.available && !push.data.enabled)
              }
              onCheckedChange={(enabled) =>
                void ws.act(async () => {
                  await call("Mobile.SetPush", enabled);
                  await push.refetch();
                })
              }
            />
            锁屏通知
          </label>
          {push.data && !push.data.available && (
            <small>请在 Hub 配置此平台的推送服务。</small>
          )}
          {push.error && <small role="alert">{String(push.error)}</small>}
        </section>
      )}
      {ownDevice && (
        <p>
          本机设备 ID <code>{ownDevice}</code>
        </p>
      )}
      <section className="hub-group">
        <h2>添加设备</h2>
        <ToggleGroup
          type="single"
          value={role}
          onValueChange={(v) => {
            if (v) {
              setRole(v);
              setTicket(undefined);
            }
          }}
        >
          {[
            ["controller", "控制端"],
            ["executor", "执行机"],
            ["workstation", "工作机"],
          ].map(([v, n]) => (
            <ToggleGroupItem value={v} key={v}>
              {n}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button
          onClick={() =>
            void ws.act(async () =>
              setTicket(
                await ws.transport.request(ws.path + "/tickets", "POST", {
                  role,
                }),
              ),
            )
          }
        >
          生成配对码
        </Button>
        {ticket && (
          <div className="hub-ticket">
            <QRCodeSVG
              value={deviceLink(ws.origin, ticket.code)}
              size={128}
              marginSize={3}
            />
            <div>
              <strong>{ticket.code}</strong>
              <p>
                {new Date(ticket.expires * 1000).toLocaleTimeString()}{" "}
                前可用一次
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  void ws.act(() =>
                    navigator.clipboard.writeText(
                      deviceLink(ws.origin, ticket.code),
                    ),
                  )
                }
              >
                复制配对链接
              </Button>
            </div>
          </div>
        )}
      </section>
      <section className="hub-group">
        {devices.map((d) => (
          <div key={d.id} className="hub-device">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = new FormData(e.currentTarget).get("name");
                void ws.act(async () => {
                  await ws.transport.request(
                    ws.path + "/devices/" + d.id,
                    "PATCH",
                    { name },
                  );
                });
              }}
            >
              <Input
                key={d.name}
                aria-label="设备名称"
                name="name"
                defaultValue={d.name}
                disabled={d.revoked}
              />
              {!d.revoked && <Button variant="outline">改名</Button>}
            </form>
            <small>
              {d.platform} · {d.role} · {deviceStatus(d)} · 同步版本 {d.version}
            </small>
            <div className="hub-actions">
              {d.role !== "controller" && !d.revoked && (
                <label className="hub-check">
                  <Switch
                    checked={d.draining}
                    onCheckedChange={(draining) =>
                      void ws.act(async () => {
                        await ws.transport.request(
                          ws.path + "/devices/" + d.id,
                          "PATCH",
                          { draining },
                        );
                      })
                    }
                  />
                  暂停接单
                </label>
              )}
              {!d.revoked && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (confirm("撤销这台设备的访问权限？"))
                      void ws.act(async () => {
                        await ws.transport.request(
                          ws.path + "/devices/" + d.id,
                          "DELETE",
                        );
                      });
                  }}
                >
                  撤销
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
      {browser && (
        <section className="hub-group">
          <h2>登录会话</h2>
          {sessions.data?.map((s) => (
            <div className="hub-device" key={s.id}>
              <span>{s.current ? "当前浏览器" : s.agent}</span>
              {!s.current && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void ws.act(async () => {
                      await ws.transport.request(
                        "/api/sessions/" + s.id,
                        "DELETE",
                      );
                    })
                  }
                >
                  撤销会话
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
      {ws.transport.kind !== "host" && (
        <Button variant="outline" onClick={logout}>
          {browser ? "退出登录" : "解除手机配对"}
        </Button>
      )}
    </>
  );
}
