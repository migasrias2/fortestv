import { useCallback, useEffect, useRef, useState } from "react";

type Tag = {
  id: string;
  label: string;
  ip?: string;
  deviceName?: string;
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
type ParsedTagPayload = {
  tagId?: string;
  ip?: string;
  deviceName?: string;
  label?: string;
};

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

const asString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const normalizePayload = (payload: ParsedTagPayload): ParsedTagPayload => ({
  tagId: payload.tagId?.trim() || undefined,
  ip: payload.ip?.trim() || undefined,
  deviceName: payload.deviceName?.trim() || undefined,
  label: payload.label?.trim() || undefined,
});

const normalizeSamsungConfig = (config: Partial<SamsungConfig>): SamsungConfig => ({
  ip: (config.ip ?? "").trim(),
  deviceName: (config.deviceName ?? "NFC Remote").trim() || "NFC Remote",
});

const parseFromSearchParams = (params: URLSearchParams): ParsedTagPayload =>
  normalizePayload({
    tagId: params.get("tag") ?? params.get("nfc") ?? params.get("id") ?? undefined,
    ip: params.get("ip") ?? params.get("tv") ?? params.get("host") ?? undefined,
    deviceName: params.get("name") ?? params.get("deviceName") ?? undefined,
    label: params.get("label") ?? params.get("room") ?? undefined,
  });

const parseUrlPayload = (raw: string): ParsedTagPayload => {
  const input = raw.trim();
  if (!input) {
    return {};
  }

  try {
    const url = new URL(input);
    return parseFromSearchParams(url.searchParams);
  } catch {
    const queryIndex = input.indexOf("?");
    if (queryIndex >= 0) {
      return parseFromSearchParams(new URLSearchParams(input.slice(queryIndex + 1)));
    }
    if (input.includes("=")) {
      return parseFromSearchParams(new URLSearchParams(input));
    }
    return {};
  }
};

const parseTextPayload = (raw: string): ParsedTagPayload => {
  const input = raw.trim();
  if (!input) {
    return {};
  }

  try {
    const json = JSON.parse(input) as Record<string, unknown>;
    return normalizePayload({
      tagId: asString(json.tagId) || asString(json.tag) || asString(json.id) || undefined,
      ip: asString(json.ip) || asString(json.tvIp) || asString(json.host) || undefined,
      deviceName: asString(json.deviceName) || asString(json.name) || undefined,
      label: asString(json.label) || asString(json.room) || undefined,
    });
  } catch {
    return parseUrlPayload(input);
  }
};

const decodeBufferSource = (data?: BufferSource) => {
  if (!data) {
    return "";
  }
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextDecoder().decode(bytes);
};

const parseNdefPayload = (records?: NdefRecord[]): ParsedTagPayload => {
  if (!Array.isArray(records)) {
    return {};
  }

  let payload: ParsedTagPayload = {};
  for (const record of records) {
    const raw = decodeBufferSource(record?.data);
    if (!raw) {
      continue;
    }

    const next =
      record.recordType === "url"
        ? parseUrlPayload(raw)
        : parseTextPayload(raw);
    payload = { ...payload, ...next };
  }

  return normalizePayload(payload);
};

const resolveSamsungConfig = (payload: ParsedTagPayload | undefined, tag: Tag | undefined, current: SamsungConfig) =>
  normalizeSamsungConfig({
    ip: payload?.ip ?? tag?.ip ?? current.ip,
    deviceName: payload?.deviceName ?? tag?.deviceName ?? current.deviceName,
  });

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
      ip?: unknown;
      deviceName?: unknown;
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
        ip: asString(tag.ip) || undefined,
        deviceName: asString(tag.deviceName) || undefined,
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
      return normalizeSamsungConfig({});
    }
    const parsed = JSON.parse(raw) as Partial<SamsungConfig>;
    return normalizeSamsungConfig(parsed);
  } catch {
    return normalizeSamsungConfig({});
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
  const [showSetup, setShowSetup] = useState(false);
  const [nfcState, setNfcState] = useState<NfcState>("idle");
  const [nfcMsg, setNfcMsg] = useState({ title: "NFC Ready", sub: "Tap scan to start" });
  const [tvState, setTvState] = useState<TvState>("disconnected");
  const [tvStatusMsg, setTvStatusMsg] = useState("Scan a trusted tag to connect");
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
    (configInput: SamsungConfig, showConnectedToast = true) => {
      const config = normalizeSamsungConfig(configInput);
      const ip = config.ip;
      const deviceName = config.deviceName;

      if (!isValidIpOrHost(ip)) {
        setTvState("error");
        setTvStatusMsg("Set a valid Samsung TV IP first");
        showToast("Add Samsung TV IP first");
        return;
      }

      setSamsungConfig(config);
      saveSamsungConfig(config);

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
    [showToast],
  );

  const triggerTag = useCallback(
    (tagId: string, payload?: ParsedTagPayload) => {
      const tag = tags.find((item) => item.id === tagId);
      const finalConfig = resolveSamsungConfig(payload, tag, samsungConfig);
      const label = tag?.label ?? payload?.label ?? "Samsung TV";
      const canConnect = Boolean(finalConfig.ip);

      if (tag || canConnect) {
        setTriggered({
          id: tagId,
          label,
          ip: finalConfig.ip || undefined,
          deviceName: finalConfig.deviceName || undefined,
          tagId,
        });

        if (canConnect) {
          connectSamsung(finalConfig, false);
          setTvStatusMsg(`Connecting to ${finalConfig.ip}...`);
          setNfcMsg({ title: "Tag detected", sub: "Connecting to Samsung TV..." });
        } else {
          setTvState("error");
          setTvStatusMsg("No TV IP found for this tag");
          setNfcMsg({ title: "Tag detected", sub: "No TV IP configured" });
          showToast("No TV IP found for this tag");
        }

        setNfcState("success");
        showToast(`Tag ${label} detected`, true);

        // If scan payload includes TV info, trust and persist this tag automatically.
        if (!tag && payload?.ip) {
          setTags((prev) => {
            const next: Tag[] = [
              ...prev.filter((item) => item.id !== tagId),
              {
                id: tagId,
                label,
                ip: finalConfig.ip || undefined,
                deviceName: finalConfig.deviceName || undefined,
              },
            ];
            saveTags(next);
            return next;
          });
        }

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
        setTagLabelInput(payload?.label ?? "");
        setAddOpen(true);
        setNfcState("success");
        setNfcMsg({ title: "New tag", sub: "Save it as a trusted tag" });
        showToast("New tag detected");
      }
    },
    [connectSamsung, samsungConfig, showToast, tags],
  );

  useEffect(() => {
    const payload = parseFromSearchParams(new URLSearchParams(window.location.search));
    if (payload.tagId) {
      triggerTag(payload.tagId, payload);
    }
  }, [triggerTag]);

  useEffect(
    () => () => {
      timeoutRefs.current.forEach((timer) => window.clearTimeout(timer));
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (nfcRef.current) {
        nfcRef.current.onreading = null;
        nfcRef.current.onreadingerror = null;
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
          triggerTag(randomTag.id, {
            tagId: randomTag.id,
            ip: randomTag.ip,
            deviceName: randomTag.deviceName,
            label: randomTag.label,
          });
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
        const payload = parseNdefPayload(records);
        const tagId = payload.tagId || serial || `tag-${Date.now()}`;
        triggerTag(tagId, payload);
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
    const config = normalizeSamsungConfig(samsungConfig);
    const next: Tag[] = [
      ...tags.filter((item) => item.id !== id),
      {
        id,
        label,
        ip: config.ip || undefined,
        deviceName: config.deviceName || undefined,
      },
    ];
    setTags(next);
    saveTags(next);
    setAddOpen(false);
    setPendingId(null);
    setTagIdInput("");
    setTagLabelInput("");
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
      if (samsungConfig.ip && tvState !== "connecting") {
        connectSamsung(samsungConfig, false);
      }
      showToast("Not connected yet. Scan tag or wait...");
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
  const updateSamsungConfig = (updates: Partial<SamsungConfig>) => {
    setSamsungConfig((prev) => {
      const next = normalizeSamsungConfig({ ...prev, ...updates });
      saveSamsungConfig(next);
      return next;
    });
  };

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground">
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Smart TV</p>
            <h1 className="text-2xl font-semibold">Samsung NFC Remote</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
              {nfcState}
            </span>
            <button
              type="button"
              onClick={() => setShowSetup((prev) => !prev)}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-secondary"
            >
              {showSetup ? "Hide setup" : "Setup"}
            </button>
          </div>
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
          {!showSetup && (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              Scan-only mode is enabled. Open setup only for first-time TV configuration.
            </p>
          )}
          {showSetup && (
            <div className="grid grid-cols-1 gap-2">
              <input
                value={samsungConfig.ip}
                onChange={(event) => updateSamsungConfig({ ip: event.target.value })}
                placeholder="TV IP or hostname (ex: 192.168.1.45)"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={samsungConfig.deviceName}
                onChange={(event) => updateSamsungConfig({ deviceName: event.target.value })}
                placeholder="Remote name"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => connectSamsung(samsungConfig, true)}
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
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <p className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">Remote</p>
          <div className="mb-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            {canSendCommands ? "Connected. Buttons are live." : "Buttons unlock right after scan + connect."}
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
                  {tag.ip && (
                    <p className="text-[11px] text-muted-foreground">TV: {tag.ip}</p>
                  )}
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
