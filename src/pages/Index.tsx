import { useCallback, useEffect, useRef, useState } from "react";

type Tag = {
  id: string;
  label: string;
};

type SamsungConfig = {
  ip: string;
  deviceName: string;
};

type NfcState = "idle" | "scanning" | "success" | "error" | "unsupported";
type TvState = "disconnected" | "connecting" | "connected" | "error";

type NdefRecord = {
  recordType?: string;
  data?: BufferSource;
};

type NdefReadingEvent = {
  serialNumber?: string;
  message?: {
    records?: NdefRecord[];
  };
};

type NdefReaderLike = {
  scan: () => Promise<void>;
  onreading: ((event: NdefReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
};

type NdefReaderCtor = new () => NdefReaderLike;

declare global {
  interface Window {
    NDEFReader?: NdefReaderCtor;
  }
}

const REMOTE_BUTTONS = [
  { cmd: "Power", icon: "⏻", key: "KEY_POWER" },
  { cmd: "Mute", icon: "🔇", key: "KEY_MUTE" },
  { cmd: "Home", icon: "⌂", key: "KEY_HOME" },
  { cmd: "Vol +", icon: "🔊", key: "KEY_VOLUP" },
  { cmd: "Vol -", icon: "🔉", key: "KEY_VOLDOWN" },
  { cmd: "CH +", icon: "⬆", key: "KEY_CHUP" },
  { cmd: "CH -", icon: "⬇", key: "KEY_CHDOWN" },
  { cmd: "Up", icon: "▲", key: "KEY_UP" },
  { cmd: "Down", icon: "▼", key: "KEY_DOWN" },
  { cmd: "Left", icon: "◀", key: "KEY_LEFT" },
  { cmd: "Right", icon: "▶", key: "KEY_RIGHT" },
  { cmd: "OK", icon: "●", key: "KEY_ENTER" },
  { cmd: "Back", icon: "↩", key: "KEY_RETURN" },
  { cmd: "Netflix", icon: "N", key: "KEY_NETFLIX" },
  { cmd: "YouTube", icon: "▷", key: "KEY_YOUTUBE" },
  { cmd: "Disney+", icon: "✦", key: "KEY_CONTENTS" },
  { cmd: "Spotify", icon: "♪", key: "KEY_MUSIC" },
];

const TAGS_KEY = "nfc_tags_v3";
const SAMSUNG_CONFIG_KEY = "samsung_config_v1";

const loadTags = (): Tag[] => {
  try {
    const saved = localStorage.getItem(TAGS_KEY);
    const legacy = localStorage.getItem("nfc_tags_v2");
    const source = saved ?? legacy;
    if (!source) {
      return [];
    }
    const parsed = JSON.parse(source) as Array<{
      id?: unknown;
      label?: unknown;
      cmd?: unknown;
    }>;
    return parsed
      .filter((tag) => typeof tag.id === "string")
      .map((tag) => ({
        id: tag.id as string,
        label:
          typeof tag.label === "string"
            ? tag.label
            : typeof tag.cmd === "string"
              ? tag.cmd
              : (tag.id as string),
      }));
  } catch {
    return [];
  }
};

const saveTags = (tags: Tag[]) => {
  localStorage.setItem(TAGS_KEY, JSON.stringify(tags));
};

const loadSamsungConfig = (): SamsungConfig => {
  try {
    const raw = localStorage.getItem(SAMSUNG_CONFIG_KEY);
    if (!raw) {
      return { ip: "", deviceName: "NFC Remote" };
    }
    const parsed = JSON.parse(raw) as Partial<SamsungConfig>;
    return {
      ip: parsed.ip ?? "",
      deviceName: parsed.deviceName ?? "NFC Remote",
    };
  } catch {
    return { ip: "", deviceName: "NFC Remote" };
  }
};

const saveSamsungConfig = (config: SamsungConfig) => {
  localStorage.setItem(SAMSUNG_CONFIG_KEY, JSON.stringify(config));
};

const tokenKey = (ip: string) => `samsung_token_${ip}`;

const getSamsungToken = (ip: string) => localStorage.getItem(tokenKey(ip));

const setSamsungToken = (ip: string, token: string) => {
  localStorage.setItem(tokenKey(ip), token);
};

const isValidIpOrHost = (value: string) => {
  const v = value.trim();
  if (!v) {
    return false;
  }
  return /^[a-zA-Z0-9.-]+$/.test(v);
};

const getSamsungWsUrl = (ip: string, deviceName: string, token?: string) => {
  const name = window.btoa(deviceName);
  const base = `ws://${ip}:8001/api/v2/channels/samsung.remote.control`;
  const tokenPart = token ? `&token=${encodeURIComponent(token)}` : "";
  return `${base}?name=${encodeURIComponent(name)}${tokenPart}`;
};

function useToast() {
  const [toast, setToast] = useState({ msg: "", ok: false, show: false });
  const timerRef = useRef<number | null>(null);

  const show = useCallback((msg: string, ok = false) => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    setToast({ msg, ok, show: true });
    timerRef.current = window.setTimeout(() => {
      setToast((prev) => ({ ...prev, show: false }));
    }, 2200);
  }, []);

  return [toast, show] as const;
}

type RemoteButtonProps = {
  cmd: string;
  icon: string;
  onClick: () => void;
  flash: boolean;
  disabled: boolean;
};

const RemoteButton = ({ cmd, icon, onClick, flash, disabled }: RemoteButtonProps) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`rounded-xl border px-3 py-2 text-sm transition ${
      flash
        ? "border-primary bg-primary/15 text-foreground"
        : "border-border bg-card text-foreground"
    } ${
      disabled
        ? "cursor-not-allowed opacity-50"
        : "hover:bg-secondary"
    }`}
  >
    <div className="text-base leading-none">{icon}</div>
    <div className="mt-1 text-[11px] font-medium">{cmd}</div>
  </button>
);

const Index = () => {
  const [tags, setTags] = useState<Tag[]>(loadTags);
  const [samsungConfig, setSamsungConfig] = useState<SamsungConfig>(loadSamsungConfig);
  const [nfcState, setNfcState] = useState<NfcState>("idle");
  const [nfcMsg, setNfcMsg] = useState({ title: "NFC Ready", sub: "Tap scan to start" });
  const [tvState, setTvState] = useState<TvState>("disconnected");
  const [tvStatusMsg, setTvStatusMsg] = useState("Scan a paired tag to connect");
  const [triggered, setTriggered] = useState<(Tag & { tagId: string }) | null>(null);
  const [flashCmd, setFlashCmd] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [tagIdInput, setTagIdInput] = useState("");
  const [tagLabelInput, setTagLabelInput] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  const nfcRef = useRef<NdefReaderLike | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const scanningRef = useRef(false);
  const timeoutRefs = useRef<number[]>([]);

  const disconnectSamsung = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setTvState("disconnected");
    setTvStatusMsg("Disconnected");
  }, []);

  const connectSamsung = useCallback(
    (showConnectedToast = true) => {
      const ip = samsungConfig.ip.trim();
      const deviceName = samsungConfig.deviceName.trim() || "NFC Remote";

      if (!isValidIpOrHost(ip)) {
        setTvState("error");
        setTvStatusMsg("Set a valid Samsung TV IP first");
        showToast("Add Samsung TV IP first");
        return;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      setTvState("connecting");
      setTvStatusMsg(`Connecting to ${ip}...`);

      const token = getSamsungToken(ip) ?? undefined;
      const ws = new WebSocket(getSamsungWsUrl(ip, deviceName, token));
      wsRef.current = ws;

      const timeout = window.setTimeout(() => {
        if (wsRef.current === ws && ws.readyState !== WebSocket.OPEN) {
          ws.close();
          setTvState("error");
          setTvStatusMsg("Connection timed out");
          showToast("Connection timeout");
        }
      }, 6500);

      ws.onopen = () => {
        window.clearTimeout(timeout);
        if (wsRef.current !== ws) {
          ws.close();
          return;
        }
        setTvState("connected");
        setTvStatusMsg(`Connected: ${ip}`);
        if (showConnectedToast) {
          showToast("Samsung connected", true);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            event?: string;
            data?: { token?: string };
          };
          if (msg.event === "ms.channel.connect" && msg.data?.token) {
            setSamsungToken(ip, msg.data.token);
          }
        } catch {
          // Ignore non-JSON websocket messages.
        }
      };

      ws.onerror = () => {
        setTvState("error");
        setTvStatusMsg("Could not connect");
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
          setTvState("disconnected");
          setTvStatusMsg("Disconnected");
        }
      };
    },
    [samsungConfig.deviceName, samsungConfig.ip, showToast],
  );

  const triggerTag = useCallback(
    (tagId: string) => {
      const tag = tags.find((item) => item.id === tagId);
      if (tag) {
        setTriggered({ ...tag, tagId });
        connectSamsung(false);
        setNfcState("success");
        setNfcMsg({ title: "Tag detected", sub: `Connecting to Samsung TV...` });
        showToast(`Tag ${tag.label} detected`, true);

        timeoutRefs.current.push(
          window.setTimeout(() => {
            setFlashCmd(null);
          }, 1800),
        );
        timeoutRefs.current.push(
          window.setTimeout(() => {
            setTriggered(null);
            setNfcState("idle");
            setNfcMsg({ title: "NFC Ready", sub: "Tap scan to start" });
          }, 3000),
        );
      } else {
        setPendingId(tagId);
        setTagIdInput(tagId);
        setTagLabelInput("");
        setAddOpen(true);
        setNfcState("success");
        setNfcMsg({ title: "New tag", sub: "Save it as a trusted tag" });
        showToast("New tag detected");
      }
    },
    [connectSamsung, showToast, tags],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tagId = params.get("tag") || params.get("nfc");
    if (tagId) {
      triggerTag(tagId);
    }
  }, [triggerTag]);

  useEffect(
    () => () => {
      timeoutRefs.current.forEach((timer) => window.clearTimeout(timer));
      if (wsRef.current) {
        wsRef.current.close();
      }
    },
    [],
  );

  const stopNfc = useCallback(() => {
    scanningRef.current = false;
    nfcRef.current = null;
    setNfcState("idle");
    setNfcMsg({ title: "NFC Ready", sub: "Tap scan to start" });
  }, []);

  const startNfc = useCallback(async () => {
    if (scanningRef.current) {
      stopNfc();
      return;
    }

    const ReaderCtor = window.NDEFReader;
    if (!ReaderCtor) {
      setNfcState("unsupported");
      setNfcMsg({ title: "NFC unavailable", sub: "Running demo trigger" });
      showToast("NFC not supported, demo mode");
      if (tags.length === 0) {
        showToast("Add at least one tag first");
        return;
      }

      timeoutRefs.current.push(
        window.setTimeout(() => {
          const randomTag = tags[Math.floor(Math.random() * tags.length)];
          triggerTag(randomTag.id);
        }, 900),
      );
      return;
    }

    try {
      const reader = new ReaderCtor();
      nfcRef.current = reader;
      await reader.scan();
      scanningRef.current = true;
      setNfcState("scanning");
      setNfcMsg({ title: "Scanning", sub: "Bring a tag close to phone" });

      reader.onreading = (event) => {
        const serial = event.serialNumber;
        const records = event.message?.records;
        let tagId = serial || `tag-${Date.now()}`;

        if (Array.isArray(records)) {
          for (const record of records) {
            if (record?.recordType !== "url" || !record?.data) {
              continue;
            }
            const url = new TextDecoder().decode(record.data);
            const match = url.match(/[?&]tag=([^&]+)/);
            if (match?.[1]) {
              tagId = decodeURIComponent(match[1]);
              break;
            }
          }
        }

        triggerTag(tagId);
      };

      reader.onreadingerror = () => {
        setNfcState("error");
        setNfcMsg({ title: "Read error", sub: "Try again" });
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start NFC";
      setNfcState("error");
      setNfcMsg({ title: "NFC error", sub: message });
    }
  }, [showToast, stopNfc, tags, triggerTag]);

  const openAdd = useCallback((tagId?: string) => {
    setPendingId(tagId ?? null);
    setTagIdInput(tagId ?? "");
    setTagLabelInput("");
    setAddOpen(true);
  }, []);

  const saveTag = () => {
    const id = tagIdInput.trim() || pendingId || `tag-${Date.now()}`;
    if (!id) {
      showToast("Tag id is required");
      return;
    }
    const label = tagLabelInput.trim() || "Samsung TV";
    const next: Tag[] = [...tags.filter((item) => item.id !== id), { id, label }];
    setTags(next);
    saveTags(next);
    setAddOpen(false);
    setPendingId(null);
    showToast(`✓ Saved tag ${label}`, true);
  };

  const deleteTag = (id: string) => {
    const next = tags.filter((item) => item.id !== id);
    setTags(next);
    saveTags(next);
    showToast("Tag removed");
  };

  const sendCmd = (cmd: string, icon: string, key: string) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showToast("Scan a paired tag to connect first");
      return;
    }

    const payload = {
      method: "ms.remote.control",
      params: {
        Cmd: "Click",
        DataOfCmd: key,
        Option: "false",
        TypeOfRemote: "SendRemoteKey",
      },
    };

    socket.send(JSON.stringify(payload));
    setFlashCmd(cmd);
    showToast(`${icon} ${cmd} sent`);
    timeoutRefs.current.push(
      window.setTimeout(() => {
        setFlashCmd((prev) => (prev === cmd ? null : prev));
      }, 450),
    );
  };

  const nfcIcon =
    nfcState === "scanning" ? "📡" : nfcState === "success" ? "✓" : nfcState === "error" ? "✕" : "◉";
  const canSendCommands = tvState === "connected";

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground">
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Smart TV</p>
            <h1 className="text-2xl font-semibold">Samsung NFC Remote</h1>
          </div>
          <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            {nfcState}
          </span>
        </header>

        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-secondary text-sm">
                {nfcIcon}
              </div>
              <div>
                <p className="text-sm font-medium">{nfcMsg.title}</p>
                <p className="text-xs text-muted-foreground">{nfcMsg.sub}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={startNfc}
              className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-secondary"
            >
              {nfcState === "scanning" ? "Stop" : "Scan"}
            </button>
          </div>
          {triggered && (
            <div className="rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-sm">
              Trusted tag: {triggered.label} ({triggered.tagId})
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Samsung TV</p>
            <span
              className={`rounded-full px-2 py-1 text-[11px] ${
                tvState === "connected"
                  ? "bg-primary/15 text-primary"
                  : tvState === "connecting"
                    ? "bg-secondary text-foreground"
                    : tvState === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-secondary text-muted-foreground"
              }`}
            >
              {tvState}
            </span>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">{tvStatusMsg}</p>
          <div className="grid grid-cols-1 gap-2">
            <input
              value={samsungConfig.ip}
              onChange={(event) => setSamsungConfig((prev) => ({ ...prev, ip: event.target.value }))}
              onBlur={() => saveSamsungConfig(samsungConfig)}
              placeholder="TV IP or hostname (ex: 192.168.1.45)"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              value={samsungConfig.deviceName}
              onChange={(event) => setSamsungConfig((prev) => ({ ...prev, deviceName: event.target.value }))}
              onBlur={() => saveSamsungConfig(samsungConfig)}
              placeholder="Remote name"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => connectSamsung(true)}
                className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary"
              >
                Connect
              </button>
              <button
                type="button"
                onClick={disconnectSamsung}
                className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary"
              >
                Disconnect
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <p className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">Remote</p>
          <div className="mb-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            {canSendCommands ? "Connected. Buttons are live." : "Buttons unlock after paired tag scan + TV connect."}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {REMOTE_BUTTONS.map((item) => (
              <RemoteButton
                key={item.cmd}
                cmd={item.cmd}
                icon={item.icon}
                flash={flashCmd === item.cmd}
                disabled={!canSendCommands}
                onClick={() => sendCmd(item.cmd, item.icon, item.key)}
              />
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Trusted NFC Tags</p>
            <button
              type="button"
              onClick={() => openAdd()}
              className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-secondary"
            >
              Add
            </button>
          </div>

          <div className="space-y-2">
            {tags.length === 0 && (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                No tags yet.
              </p>
            )}

            {tags.map((tag) => (
              <div
                key={tag.id}
                className={`flex items-center justify-between rounded-xl border px-3 py-2 ${
                  triggered?.tagId === tag.id ? "border-primary/40 bg-primary/10" : "border-border"
                }`}
              >
                <div>
                  <p className="text-sm font-medium">{tag.label}</p>
                  <p className="text-xs text-muted-foreground">{tag.id}</p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteTag(tag.id)}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>

          {addOpen && (
            <div className="mt-3 rounded-xl border border-border bg-secondary/40 p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                {pendingId ? `Detected tag: ${pendingId}` : "Add a trusted tag"}
              </p>
              <input
                value={tagLabelInput}
                onChange={(event) => setTagLabelInput(event.target.value)}
                placeholder="Tag name (ex: Living room)"
                className="mb-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={tagIdInput}
                onChange={(event) => setTagIdInput(event.target.value)}
                placeholder="Tag ID (auto or manual)"
                className="mb-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveTag}
                  className="w-full rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90"
                >
                  Save tag
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <div
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 rounded-lg border bg-card px-4 py-2 text-sm transition ${
          toast.show ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
        } ${toast.ok ? "border-primary" : "border-border"}`}
      >
        {toast.msg}
      </div>
    </main>
  );
};

export default Index;
