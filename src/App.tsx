import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import Papa from "papaparse";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import clsx from "clsx";

type RawGuest = {
  id: number;
  display_name: string;
  member_host: string | null;
  is_checked_in: boolean;
  has_history: boolean;
};

type Guest = {
  id: number;
  displayName: string;
  memberHost: string | null;
  isCheckedIn: boolean;
  hasHistory: boolean;
};

type MemberSearchResult = {
  memberHost: string;
  totalGuests: number;
  presentGuests: number;
};

type ImportSummary = {
  inserted: number;
  total_rows: number;
};

type ToggleResult = {
  status: "checked_in" | "checked_out" | "already_in" | "not_checked_in" | "never_checked_in";
};

type UndoResult = {
  status: "reverted_check_in" | "reverted_check_out" | "empty";
};

type ToastTone = "success" | "info" | "error";

type StatsSummary = {
  totalGuests: number;
  totalCheckIns: number;
  totalCheckOuts: number;
  currentlyPresent: number;
  presentGuests: PresentGuest[];
  topHosts: HostSummary[];
};

type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
};

type PresentGuest = {
  id: number;
  displayName: string;
  memberHost: string | null;
  inTs: string | null;
  operator: string | null;
};

type HostSummary = {
  memberHost: string;
  totalGuests: number;
  presentGuests: number;
};

const DEFAULT_LIMIT = 25;

function App() {
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [guestResults, setGuestResults] = useState<Guest[]>([]);
  const [memberResults, setMemberResults] = useState<MemberSearchResult[]>([]);
  const [memberGuests, setMemberGuests] = useState<Guest[]>([]);
  const [memberGuestsLoading, setMemberGuestsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);
  const [showImportModePicker, setShowImportModePicker] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [operatorId, setOperatorId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("party-operator") ?? "";
  });
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [viewMode, setViewMode] = useState<"search" | "dashboard">("search");
  const [searchMode, setSearchMode] = useState<"guest" | "member">("guest");

  useEffect(() => {
    window.localStorage.setItem("party-operator", operatorId);
  }, [operatorId]);

  const showToast = useCallback(
    (message: string, tone: ToastTone) => {
      setToast({ id: Date.now(), message, tone });
      setTimeout(() => {
        setToast((current) => (current?.message === message ? null : current));
      }, 3400);
    },
    []
  );

  const refreshStats = useCallback(
    async (path?: string) => {
      const target = path ?? dbPath;
      if (!target) return;
      try {
        const payload = await invoke<StatsSummary>("stats_summary", { dbPath: target });
        setStats(payload);
      } catch (error) {
        console.error(error);
      }
    },
    [dbPath]
  );

  const mapRawGuest = useCallback(
    (guest: RawGuest): Guest => ({
      id: guest.id,
      displayName: guest.display_name,
      memberHost: guest.member_host,
      isCheckedIn: guest.is_checked_in,
      hasHistory: guest.has_history,
    }),
    []
  );

  const runGuestSearch = useCallback(
    async (db: string, text: string) => {
      setIsSearching(true);
      try {
        const payload = await invoke<RawGuest[]>("search_guests", {
          dbPath: db,
          q: text,
          limit: DEFAULT_LIMIT,
        });
        const mapped = payload.map(mapRawGuest);
        setGuestResults(mapped);
        if (searchMode === "guest") {
          setSelectedIndex(0);
        }
      } catch (error) {
        console.error(error);
        showToast("Search failed", "error");
      } finally {
        setIsSearching(false);
      }
    },
    [mapRawGuest, searchMode, showToast]
  );

  const runMemberSearch = useCallback(
    async (db: string, text: string) => {
      setIsSearching(true);
      try {
        const payload = await invoke<MemberSearchResult[]>("search_members", {
          dbPath: db,
          q: text,
          limit: DEFAULT_LIMIT,
        });
        setMemberResults(payload);
        if (searchMode === "member") {
          setSelectedIndex(0);
        }
      } catch (error) {
        console.error(error);
        showToast("Member search failed", "error");
      } finally {
        setIsSearching(false);
      }
    },
    [searchMode, showToast]
  );

  const fetchMemberGuests = useCallback(
    async (memberHost: string) => {
      if (!dbPath || memberHost.trim().length === 0) {
        setMemberGuests([]);
        return;
      }
      setMemberGuestsLoading(true);
      try {
        const payload = await invoke<RawGuest[]>("guests_for_member", {
          dbPath,
          memberHost,
        });
        setMemberGuests(payload.map(mapRawGuest));
      } catch (error) {
        console.error(error);
      } finally {
        setMemberGuestsLoading(false);
      }
    },
    [dbPath, mapRawGuest]
  );

  const bootstrap = useCallback(async () => {
    const base = await appDataDir();
    const db = await join(base, "app.db");
    await invoke("init_db", { dbPath: db });
    setDbPath(db);
    await runGuestSearch(db, "");
    await runMemberSearch(db, "");
    await refreshStats(db);
  }, [refreshStats, runGuestSearch, runMemberSearch]);

  useEffect(() => {
    bootstrap().catch((error) => {
      console.error(error);
      showToast("Failed to initialize database", "error");
    });
  }, [bootstrap, showToast]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchMode]);

  useEffect(() => {
    if (viewMode === "dashboard") {
      void refreshStats();
    }
  }, [refreshStats, viewMode]);

  useEffect(() => {
    if (!dbPath) return;
    const handle = setTimeout(() => {
      const task = searchMode === "guest"
        ? runGuestSearch(dbPath, query)
        : runMemberSearch(dbPath, query);
      task.catch((error) => {
        console.error(error);
      });
    }, query.length > 1 ? 80 : 0);

    return () => clearTimeout(handle);
  }, [dbPath, query, searchMode, runGuestSearch, runMemberSearch]);

  const selectedGuest = useMemo(() => {
    if (searchMode !== "guest" || !guestResults.length) return null;
    return guestResults[Math.max(0, Math.min(selectedIndex, guestResults.length - 1))];
  }, [guestResults, searchMode, selectedIndex]);

  const selectedMember = useMemo(() => {
    if (searchMode !== "member" || !memberResults.length) return null;
    return memberResults[Math.max(0, Math.min(selectedIndex, memberResults.length - 1))];
  }, [memberResults, searchMode, selectedIndex]);

  useEffect(() => {
    if (searchMode !== "member" || !selectedMember?.memberHost) {
      setMemberGuests([]);
      setMemberGuestsLoading(false);
      return;
    }
    void fetchMemberGuests(selectedMember.memberHost);
  }, [fetchMemberGuests, searchMode, selectedMember]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const listLength = searchMode === "guest" ? guestResults.length : memberResults.length;

    if (!listLength) {
      if (event.key === "Enter") {
        event.preventDefault();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undoLast();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, listLength - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (searchMode === "member") {
        if (selectedMember) {
          setSearchMode("guest");
          setQuery(selectedMember.memberHost);
        }
        return;
      }

      if (!selectedGuest) return;

      if (event.shiftKey) {
        void toggleGuest(selectedGuest, "out", true);
      } else if (selectedGuest.isCheckedIn) {
        void toggleGuest(selectedGuest, "out");
      } else {
        void toggleGuest(selectedGuest, "in");
      }
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void undoLast();
    }
  };

  const toggleGuest = useCallback(
    async (guest: Guest, action: "in" | "out", force = false) => {
      if (!dbPath) return;
      try {
        const payload = await invoke<ToggleResult>("toggle_checkin", {
          dbPath,
          guestId: guest.id,
          action,
          operator: operatorId || null,
          force,
        });

        switch (payload.status) {
          case "checked_in":
            showToast(`Checked in ${guest.displayName}`, "success");
            if (searchMode === "guest") {
              setQuery("");
            }
            break;
          case "checked_out":
            showToast(`Checked out ${guest.displayName}`, "info");
            if (searchMode === "guest") {
              setQuery("");
            }
            break;
          case "already_in":
            showToast(`${guest.displayName} already checked in`, "info");
            break;
          case "not_checked_in":
            showToast(`${guest.displayName} is already checked out`, "info");
            break;
          case "never_checked_in":
            showToast(`${guest.displayName} has never been checked in`, "info");
            break;
        }
      } catch (error) {
        console.error(error);
        showToast("Check-in failed", "error");
      } finally {
        if (dbPath) {
          if (searchMode === "guest") {
            await runGuestSearch(dbPath, action === "in" ? "" : query);
          } else {
            await runGuestSearch(dbPath, "");
            await runMemberSearch(dbPath, query);
            if (selectedMember?.memberHost) {
              await fetchMemberGuests(selectedMember.memberHost);
            }
          }
          await refreshStats();
        }
      }
    },
    [dbPath, fetchMemberGuests, operatorId, query, refreshStats, runGuestSearch, runMemberSearch, searchMode, selectedMember, showToast]
  );

  const undoLast = useCallback(async () => {
    if (!dbPath) return;
    try {
      const payload = await invoke<UndoResult>("undo_last", { dbPath });
      switch (payload.status) {
        case "reverted_check_in":
          showToast("Reverted last check-in", "info");
          break;
        case "reverted_check_out":
          showToast("Reverted last check-out", "info");
          break;
        case "empty":
          showToast("Nothing to undo", "info");
          break;
      }
    } catch (error) {
      console.error(error);
      showToast("Undo failed", "error");
    } finally {
      if (dbPath) {
        await runGuestSearch(dbPath, query);
        await refreshStats();
      }
    }
  }, [dbPath, query, refreshStats, runGuestSearch, showToast]);

  const beginImport = useCallback(async () => {
    try {
      const selection = await open({
        filters: [{ name: "CSV", extensions: ["csv"] }],
        multiple: false,
      });
      if (!selection || Array.isArray(selection)) {
        return;
      }
      setPendingImportPath(selection);
      setShowImportModePicker(true);
    } catch (error) {
      console.error(error);
      showToast("Unable to open CSV", "error");
    }
  }, [showToast]);

  const importCsv = useCallback(
    async (mode: "replace" | "append") => {
      if (!dbPath || !pendingImportPath) return;
      setImportBusy(true);
      try {
        const raw = await readTextFile(pendingImportPath);
        const parsed = Papa.parse<Record<string, string>>(raw, {
          header: true,
          skipEmptyLines: true,
        });

        if (parsed.errors.length) {
          console.warn(parsed.errors);
        }

        const rows = parsed.data.map((row, index) => {
          const pull = (keys: string[]) => {
            for (const key of keys) {
              const value = row[key];
              if (value == null) continue;
              const normalized = typeof value === "string" ? value.trim() : String(value);
              if (normalized.length === 0) continue;
              return normalized;
            }
            return null;
          };

          return {
            memberName: pull(["Member Name", "member_name"]),
            guestNames: pull(["Guest Names", "guest_names"]),
            checkIn: pull(["Check In Y/N", "check_in_y/n", "check_in_y_n"]),
            checkInTime: pull(["Check In Time", "check_in_time"]),
            checkOut: pull(["Check Out Y/N", "check_out_y/n", "check_out_y_n"]),
            checkOutTime: pull(["Check Out Time", "check_out_time"]),
            sourceRow: index + 2,
          };
        });

        const payload = await invoke<ImportSummary>("import_rows", {
          dbPath,
          rows,
          mode,
        });

        showToast(
          `Imported ${payload.total_rows} rows → ${payload.inserted} guests`,
          "success"
        );
        setQuery("");
        await runGuestSearch(dbPath, "");
        await runMemberSearch(dbPath, "");
        await refreshStats();
      } catch (error) {
        console.error(error);
        showToast("Import failed", "error");
      } finally {
        setImportBusy(false);
        setShowImportModePicker(false);
        setPendingImportPath(null);
      }
    },
    [dbPath, pendingImportPath, refreshStats, runGuestSearch, runMemberSearch, showToast]
  );

  const exportCsv = useCallback(async () => {
    if (!dbPath) return;
    try {
      const path = await invoke<string>("export_csv", { dbPath });
      showToast(`Exported to ${path}`, "success");
      await refreshStats();
    } catch (error) {
      console.error(error);
      showToast("Export failed", "error");
    }
  }, [dbPath, refreshStats, showToast]);

  const statusBadge = useCallback((guest: Guest) => {
    if (guest.isCheckedIn) {
      return (
        <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300">
          Checked in
        </span>
      );
    }
    if (guest.hasHistory) {
      return (
        <span className="rounded-full bg-amber-400/10 px-2 py-1 text-xs text-amber-200">
          Checked out
        </span>
      );
    }
    return (
      <span className="rounded-full bg-slate-100/10 px-2 py-1 text-xs text-slate-200">
        Never checked in
      </span>
    );
  }, []);

  const StatCard = ({
    label,
    value,
    tone = "default",
    description,
  }: {
    label: string;
    value: number;
    tone?: "default" | "success" | "info" | "warning";
    description?: string;
  }) => {
    const palette: Record<string, string> = {
      default: "border border-slate-700 bg-slate-900/60 text-slate-200",
      success: "border border-emerald-500/40 bg-emerald-500/10 text-emerald-100",
      info: "border border-sky-500/40 bg-sky-500/10 text-sky-100",
      warning: "border border-amber-500/40 bg-amber-500/10 text-amber-100",
    };
    const formatted = value.toLocaleString();
    return (
      <div className={clsx("rounded-lg p-4 shadow-sm", palette[tone])}>
        <div className="text-xs font-medium uppercase tracking-wide opacity-80">{label}</div>
        <div className="mt-2 text-2xl font-semibold">{formatted}</div>
        {description ? (
          <div className="mt-1 text-xs opacity-80">{description}</div>
        ) : null}
      </div>
    );
  };

  const totalGuests = stats?.totalGuests ?? 0;
  const totalCheckIns = stats?.totalCheckIns ?? 0;
  const totalCheckOuts = stats?.totalCheckOuts ?? 0;
  const presentNow = stats?.currentlyPresent ?? Math.max(totalCheckIns - totalCheckOuts, 0);
  const topHosts = stats?.topHosts ?? [];
  const presentGuestsList = stats?.presentGuests ?? [];
  const maxHostTotal = topHosts.length > 0 ? Math.max(...topHosts.map((host) => host.totalGuests)) : 1;
  const searchPlaceholder =
    searchMode === "guest" ? "Search guests by name" : "Search brothers by member name";
  const listItemsCount = searchMode === "guest" ? guestResults.length : memberResults.length;
  const headerSubtitle =
    viewMode === "search"
      ? searchMode === "guest"
        ? "Search guests · Enter toggles check-in/out · Shift+Enter forces check-out"
        : "Search brothers"
      : "Live attendance dashboard and insights";

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-800 bg-slate-925/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Party Sign-In</h1>
            <p className="text-sm text-slate-400">{headerSubtitle}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="inline-flex rounded-md border border-slate-700 bg-slate-900/60 p-1 text-sm">
              <button
                className={clsx(
                  "rounded-md px-3 py-1.5 font-medium",
                  viewMode === "search"
                    ? "bg-emerald-500 text-emerald-950 shadow"
                    : "text-slate-300 hover:text-white"
                )}
                onClick={() => setViewMode("search")}
              >
                Search
              </button>
              <button
                className={clsx(
                  "rounded-md px-3 py-1.5 font-medium",
                  viewMode === "dashboard"
                    ? "bg-slate-100 text-slate-900 shadow"
                    : "text-slate-300 hover:text-white"
                )}
                onClick={() => setViewMode("dashboard")}
              >
                Dashboard
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              Operator
              <input
                value={operatorId}
                onChange={(event) => setOperatorId(event.target.value)}
                className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm shadow-inner focus:border-emerald-400 focus:outline-none"
                placeholder="Initials"
              />
            </label>
            <button
              onClick={beginImport}
              className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-emerald-950 shadow hover:bg-emerald-400"
            >
              Import CSV
            </button>
            <button
              onClick={exportCsv}
              className="rounded-md border border-slate-600 px-3 py-2 text-sm font-medium text-slate-200 hover:border-slate-400 hover:text-white"
            >
              Export CSV
            </button>
            <button
              onClick={undoLast}
              className="rounded-md border border-slate-600 px-3 py-2 text-sm font-medium text-slate-200 hover:border-slate-400 hover:text-white"
            >
              Undo
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6">
        {viewMode === "search" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex rounded-md border border-slate-700 bg-slate-900/60 p-1 text-sm">
                <button
                  className={clsx(
                    "rounded-md px-3 py-1.5 font-medium",
                    searchMode === "guest"
                      ? "bg-emerald-500 text-emerald-950 shadow"
                      : "text-slate-300 hover:text-white"
                  )}
                  onClick={() => setSearchMode("guest")}
                >
                  Guests
                </button>
                <button
                  className={clsx(
                    "rounded-md px-3 py-1.5 font-medium",
                    searchMode === "member"
                      ? "bg-slate-100 text-slate-900 shadow"
                      : "text-slate-300 hover:text-white"
                  )}
                  onClick={() => setSearchMode("member")}
                >
                  Brothers
                </button>
              </div>
              <div className="text-xs text-slate-400">Results: {listItemsCount}</div>
            </div>

            <div>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                onKeyDown={handleKeyDown}
                className="h-14 w-full rounded-lg border border-slate-700 bg-slate-900 px-4 text-lg shadow focus:border-emerald-500 focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                <span>
                  {searchMode === "guest" ? (
                    selectedGuest ? (
                      <>
                        <strong className="text-slate-200">{selectedGuest.displayName}</strong>
                        {selectedGuest.memberHost ? ` · Host: ${selectedGuest.memberHost}` : ""}
                      </>
                    ) : (
                      "No matches. Press Enter for walk-in"
                    )
                  ) : selectedMember ? (
                    <>
                      <strong className="text-slate-200">{selectedMember.memberHost}</strong>
                      {` · ${selectedMember.presentGuests.toLocaleString()} present / ${selectedMember.totalGuests.toLocaleString()} total`}
                    </>
                  ) : (
                    "No brother results. Try a different name."
                  )}
                </span>
                {isSearching && <span>Searching…</span>}
              </div>
            </div>

            <section className="flex flex-1 flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-900/40 shadow-inner">
              <div className="border-b border-slate-800 px-4 py-2 text-xs uppercase tracking-wide text-slate-400">
                Results ({listItemsCount})
              </div>
              <div className="flex-1 overflow-y-auto">
                {searchMode === "guest" ? (
                  guestResults.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400">
                      <p>No matches</p>
                      <p>Check spelling or import a guest list.</p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {guestResults.map((guest, index) => (
                        <li
                          key={guest.id}
                          onMouseEnter={() => setSelectedIndex(index)}
                          onDoubleClick={() =>
                            void toggleGuest(guest, guest.isCheckedIn ? "out" : "in")
                          }
                          className={clsx(
                            "flex cursor-pointer items-center justify-between gap-3 px-4 py-3",
                            index === selectedIndex
                              ? "bg-emerald-500/10"
                              : "hover:bg-slate-800/50"
                          )}
                        >
                          <div>
                            <div className="text-base font-medium text-slate-50">
                              {guest.displayName}
                            </div>
                            <div className="text-xs text-slate-400">
                              {guest.memberHost ? `Host: ${guest.memberHost}` : "No host"}
                            </div>
                          </div>
                          {statusBadge(guest)}
                        </li>
                      ))}
                    </ul>
                  )
                ) : memberResults.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400">
                    <p>No matches</p>
                    <p>We couldn’t find that brother.</p>
                  </div>
                ) : (
                  <div className="flex h-full flex-col md:flex-row">
                    <div className="md:w-5/12 md:border-r md:border-slate-800">
                      <ul className="divide-y divide-slate-800">
                        {memberResults.map((member, index) => {
                          const ratio = member.totalGuests > 0
                            ? Math.min(100, Math.round((member.presentGuests / member.totalGuests) * 100))
                            : 0;
                          const active = index === selectedIndex;
                          return (
                            <li
                              key={member.memberHost}
                              onMouseEnter={() => setSelectedIndex(index)}
                              onClick={() => setSelectedIndex(index)}
                              className={clsx(
                                "flex cursor-pointer items-center justify-between gap-3 px-4 py-3",
                                active ? "bg-slate-100/10" : "hover:bg-slate-800/50"
                              )}
                            >
                              <div>
                                <div className="text-base font-medium text-slate-50">
                                  {member.memberHost}
                                </div>
                                <div className="text-xs text-slate-400">
                                  {member.presentGuests.toLocaleString()} present · {member.totalGuests.toLocaleString()} total
                                </div>
                              </div>
                              <div className="flex w-32 items-center gap-2">
                                <div className="h-2 flex-1 rounded-full bg-slate-800">
                                  <div
                                    className="h-full rounded-full bg-emerald-500"
                                    style={{ width: `${ratio}%` }}
                                  />
                                </div>
                                <span className="text-xs text-slate-400">{ratio}%</span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    <div className="mt-4 flex-1 md:mt-0 md:border-l md:border-slate-800">
                      {selectedMember ? (
                        <div className="flex h-full flex-col">
                          <div className="border-b border-slate-800 px-4 py-3">
                            <div className="text-sm font-semibold text-slate-100">
                              {selectedMember.memberHost}
                            </div>
                            <div className="text-xs text-slate-400">
                              {selectedMember.presentGuests.toLocaleString()} present · {selectedMember.totalGuests.toLocaleString()} total guests
                            </div>
                          </div>
                          <div className="flex-1 overflow-y-auto">
                            {memberGuestsLoading ? (
                              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                                Loading guests…
                              </div>
                            ) : memberGuests.length === 0 ? (
                              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400">
                                <p>No guests on file for this brother.</p>
                              </div>
                            ) : (
                              <ul className="divide-y divide-slate-800">
                                {memberGuests.map((guest) => (
                                  <li key={guest.id} className="flex items-center justify-between gap-3 px-4 py-3">
                                    <div>
                                      <div className="text-sm font-medium text-slate-100">{guest.displayName}</div>
                                      <div className="text-xs text-slate-500">
                                        {guest.memberHost ? `Host: ${guest.memberHost}` : "No host"}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                      {statusBadge(guest)}
                                      <button
                                        className={clsx(
                                          "rounded-md px-3 py-1 text-xs font-semibold",
                                          guest.isCheckedIn
                                            ? "bg-slate-700 text-slate-100 hover:bg-slate-600"
                                            : "bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                                        )}
                                        onClick={() =>
                                          void toggleGuest(
                                            guest,
                                            guest.isCheckedIn ? "out" : "in"
                                          )
                                        }
                                      >
                                        {guest.isCheckedIn ? "Check out" : "Check in"}
                                      </button>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400">
                          <p>Select a brother to view their guests.</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </>
        ) : stats ? (
          <div className="flex flex-1 flex-col gap-6">
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Checked In" value={totalCheckIns} tone="success" />
              <StatCard label="Checked Out" value={totalCheckOuts} tone="info" />
              <StatCard
                label="Present Now"
                value={presentNow}
                tone="warning"
                description={`Checked in (${totalCheckIns.toLocaleString()}) − Checked out (${totalCheckOuts.toLocaleString()}) = ${presentNow.toLocaleString()}`}
              />
              <StatCard label="Total Guests" value={totalGuests} />
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/40 shadow-inner">
              <div className="border-b border-slate-800 px-4 py-2 text-xs uppercase tracking-wide text-slate-400">
                Top Hosts on Site
              </div>
              <div className="max-h-64 overflow-y-auto">
                {topHosts.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-slate-400">No host data yet.</div>
                ) : (
                  <ul className="divide-y divide-slate-800">
                    {topHosts.map((host) => {
                      const bar = host.totalGuests > 0
                        ? Math.min(100, Math.round((host.presentGuests / maxHostTotal) * 100))
                        : 0;
                      return (
                        <li key={host.memberHost} className="px-4 py-3">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium text-slate-200">{host.memberHost}</span>
                            <span className="text-slate-400">
                              {host.presentGuests.toLocaleString()} / {host.totalGuests.toLocaleString()} present
                            </span>
                          </div>
                          <div className="mt-2 h-2 rounded-full bg-slate-800">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${bar}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            <section className="flex flex-1 flex-col rounded-lg border border-slate-800 bg-slate-900/40 shadow-inner">
              <div className="border-b border-slate-800 px-4 py-2 text-xs uppercase tracking-wide text-slate-400">
                Currently Present ({presentGuestsList.length})
              </div>
              <div className="flex-1 overflow-y-auto">
                {presentGuestsList.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400">
                    <p>No one is checked in right now.</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-800">
                    {presentGuestsList.map((guest) => (
                      <li key={guest.id} className="px-4 py-3 text-sm text-slate-200">
                        <div className="font-medium">{guest.displayName}</div>
                        <div className="text-xs text-slate-400">
                          {guest.memberHost ? `Host: ${guest.memberHost}` : "No host"}
                          {guest.inTs ? ` · In at ${guest.inTs}` : ""}
                          {guest.operator ? ` · ${guest.operator}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
            Loading dashboard…
          </div>
        )}
      </main>

      {toast && (
        <div
          key={toast.id}
          className={clsx(
            "pointer-events-none fixed bottom-6 left-1/2 w-full max-w-md -translate-x-1/2 rounded-lg px-4 py-3 text-center text-sm font-medium shadow-lg",
            toast.tone === "success" && "bg-emerald-500 text-emerald-950",
            toast.tone === "info" && "bg-slate-100 text-slate-900",
            toast.tone === "error" && "bg-rose-500 text-rose-50"
          )}
        >
          {toast.message}
        </div>
      )}

      {showImportModePicker && pendingImportPath && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 backdrop-blur">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-100">Import guest list</h2>
            <p className="mt-2 text-sm text-slate-400">
              Choose how to bring the CSV into the current event.
            </p>
            <p className="mt-3 break-all rounded-md bg-slate-800 px-3 py-2 text-xs text-slate-300">
              {pendingImportPath}
            </p>
            <div className="mt-6 grid gap-3">
              <button
                disabled={importBusy}
                onClick={() => void importCsv("replace")}
                className="rounded-md bg-rose-500 px-4 py-3 text-left text-sm font-semibold text-rose-50 shadow hover:bg-rose-400 disabled:cursor-wait disabled:opacity-70"
              >
                Replace event
                <span className="block text-xs font-normal text-rose-50/80">
                  Clear all guests and check-ins before importing.
                </span>
              </button>
              <button
                disabled={importBusy}
                onClick={() => void importCsv("append")}
                className="rounded-md bg-emerald-500 px-4 py-3 text-left text-sm font-semibold text-emerald-950 shadow hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-70"
              >
                Append only new names
                <span className="block text-xs font-normal text-emerald-950/80">
                  Keep existing guests and add any new ones.
                </span>
              </button>
            </div>
            <button
              onClick={() => {
                if (!importBusy) {
                  setShowImportModePicker(false);
                  setPendingImportPath(null);
                }
              }}
              className="mt-4 w-full rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
