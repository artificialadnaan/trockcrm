import { useState, useEffect, useCallback } from "react";

const SECTIONS = [
  { id: "s0", title: "Pre-Build Setup", icon: "⚙️", items: [
    "Signed SOW received", "Deposit received", "GitHub repo + project structure", "Railway deployment (server + DB + Redis)",
    "Cloudflare R2 file storage", "Email notification service", "Microsoft 365 API access", "Procore API access",
    "HubSpot data export received", "Database schema design", "Stage definitions finalized", "Field requirements per stage", "Role permissions matrix"
  ]},
  { id: "s1", title: "Pipeline & Deals", icon: "📊", items: [
    "Deal data model", "Custom stage pipeline (DD → Closed)", "Visual pipeline with drag-and-drop", "DD separated from active pipeline",
    "Multi-estimate tracking (DD/bid/awarded/CO)", "Stage transition validation gates", "Backward movement protection (Director only)",
    "Mandatory lost-deal notes + reason", "Competitor tracking on lost deals", "Stale deal alert engine (30/60/90 day)",
    "Stale deal notifications", "Stale deals dashboard widget", "Deal detail view (full record)"
  ]},
  { id: "s2", title: "Reporting & Dashboards", icon: "📈", items: [
    "Per-rep dashboard", "Director dashboard (all reps)", "Click-into-rep detail view", "Report: Pipeline by stage",
    "Report: Pipeline by rep", "Report: Closed Won summary", "Report: Closed Lost + reasons", "Report: Activity per rep",
    "Report: Revenue forecast", "Locked company-wide filters", "Filter within reports", "Pie charts", "Bar charts", "Trend lines",
    "Month-over-month comparison", "Quarter-over-quarter comparison", "Year-over-year comparison", "Calls tracked per rep",
    "Emails tracked per rep", "Tasks tracked per rep", "Follow-up compliance", "DD vs true pipeline views", "Custom report builder"
  ]},
  { id: "s3", title: "Procore Integration", icon: "🔗", items: [
    "Procore API setup", "Bi-directional deal/project sync", "Bi-directional stage sync", "Stage mapping guardrails",
    "Personal project board per rep", "Bid Board: new opportunities", "Bid Board: stage changes", "Bid Board: assignments",
    "Bid Board → Portfolio automation", "Deal → Procore project automation", "Change order auto-updates", "Procore sync job"
  ]},
  { id: "s4", title: "Email & Communication", icon: "✉️", items: [
    "Microsoft Graph API setup", "Send email from CRM", "Receive/sync inbound email", "Auto-log emails to deals",
    "Auto-log emails to contacts", "Email thread history on deals", "Inbound email → auto task", "Contact touchpoint counter",
    "Manual call logging", "Note/meeting logging", "Email sync job"
  ]},
  { id: "s5", title: "Contact Directory", icon: "👥", items: [
    "Contact data model", "Contact categories", "Directory with search + filter", "Contact detail view",
    "Contact-to-deal links", "Duplicate detection", "Touchpoint alerts", "Contact management (CRUD)"
  ]},
  { id: "s6", title: "Photos & Documents", icon: "📷", items: [
    "Cloudflare R2 integration", "Photo upload UI", "Photo tagging on deals", "Photos on properties/projects",
    "Photo timeline per deal", "Cross-team photo sharing", "Document attachments on deals", "Multi file-type support"
  ]},
  { id: "s7", title: "Audit Trail", icon: "🔍", items: [
    "Audit log data model", "Auto-log deal changes", "Auto-log contact changes", "Stage change timeline",
    "Data entry guardrails (dropdowns)", "Required fields at transitions", "T Rock-specific options only", "Audit log viewer"
  ]},
  { id: "s8", title: "Alerts & Tasks", icon: "🔔", items: [
    "Task data model", "Daily task list generation", "Task prioritization engine", "Task list UI",
    "Stale deal notifications", "Follow-up reminders", "Activity drop alerts", "Alert email delivery"
  ]},
  { id: "s9", title: "Multi-Office", icon: "🏢", items: [
    "Office data model", "All data scoped by office", "Per-office data isolation", "Cross-office reporting",
    "Centralized admin panel", "Office-scoped dashboards"
  ]},
  { id: "s10", title: "Auth & Users", icon: "🔐", items: [
    "User data model", "Login/logout/sessions", "Role-based permissions", "User management (admin)",
    "Route + API permission guards", "Password reset", "Responsive mobile layout"
  ]},
  { id: "s11", title: "Migration & Launch", icon: "🚀", items: [
    "HubSpot field mapping", "Migration script", "Sales team data cleanup", "Staging migration",
    "Data validation with team", "Production migration", "Team training", "User guide",
    "Admin guide", "Go-live", "On-site support week", "Final payment collected", "HubSpot non-renewal confirmed"
  ]},
];

const STORAGE_KEY = "trock-client-tracker-v1";

const defaultState = () => {
  const items = {};
  const logs = [];
  SECTIONS.forEach(s => {
    s.items.forEach((item, i) => {
      items[`${s.id}-${i}`] = "not_started";
    });
  });
  return { items, logs };
};

export default function ClientTracker() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adminMode, setAdminMode] = useState(false);
  const [adminPass, setAdminPass] = useState("");
  const [logInput, setLogInput] = useState("");
  const [activeSection, setActiveSection] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const result = await window.storage.get(STORAGE_KEY, true);
        if (result?.value) setState(JSON.parse(result.value));
        else setState(defaultState());
      } catch { setState(defaultState()); }
      setLoading(false);
    }
    load();
  }, []);

  const save = useCallback(async (newState) => {
    setState(newState);
    try { await window.storage.set(STORAGE_KEY, JSON.stringify(newState), true); } catch (e) { console.error(e); }
  }, []);

  const setStatus = (key, status) => {
    save({ ...state, items: { ...state.items, [key]: status } });
  };

  const addLog = () => {
    if (!logInput.trim()) return;
    const entry = { date: new Date().toISOString(), text: logInput.trim() };
    save({ ...state, logs: [entry, ...state.logs] });
    setLogInput("");
  };

  const removeLog = (idx) => {
    const newLogs = state.logs.filter((_, i) => i !== idx);
    save({ ...state, logs: newLogs });
  };

  if (loading || !state) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#fafaf9", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ color: "#a8a29e" }}>Loading...</div>
    </div>
  );

  const totalItems = Object.keys(state.items).length;
  const doneItems = Object.values(state.items).filter(v => v === "done").length;
  const inProgressItems = Object.values(state.items).filter(v => v === "in_progress").length;
  const pct = Math.round((doneItems / totalItems) * 100);

  const sectionStats = SECTIONS.map(s => {
    const keys = s.items.map((_, i) => `${s.id}-${i}`);
    const done = keys.filter(k => state.items[k] === "done").length;
    const inProg = keys.filter(k => state.items[k] === "in_progress").length;
    return { ...s, done, inProg, total: s.items.length, pct: Math.round((done / s.items.length) * 100) };
  });

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const todayLogs = state.logs.filter(l => new Date(l.date).toDateString() === new Date().toDateString());

  const statusColors = {
    not_started: { bg: "#f5f5f4", text: "#a8a29e", dot: "#d6d3d1" },
    in_progress: { bg: "#eff6ff", text: "#2563eb", dot: "#3b82f6" },
    done: { bg: "#f0fdf4", text: "#16a34a", dot: "#22c55e" },
    blocked: { bg: "#fef2f2", text: "#dc2626", dot: "#ef4444" },
  };

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", background: "#fafaf9", minHeight: "100vh", color: "#292524" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ background: "#1c1917", color: "#fafaf9", padding: "32px 24px 28px" }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: "2px", color: "#78716c", textTransform: "uppercase", marginBottom: 6 }}>T Rock Construction</div>
              <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: "-0.5px" }}>Custom CRM — Build Status</h1>
              <div style={{ fontSize: 13, color: "#a8a29e", marginTop: 6 }}>{today}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 42, fontWeight: 700, color: pct === 100 ? "#22c55e" : "#fafaf9", lineHeight: 1 }}>{pct}%</div>
              <div style={{ fontSize: 11, color: "#78716c", marginTop: 2 }}>{doneItems} of {totalItems} complete</div>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ marginTop: 20, background: "#292524", borderRadius: 6, height: 10, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 6, transition: "width 0.5s ease",
              width: `${pct}%`,
              background: pct === 100 ? "#22c55e" : "linear-gradient(90deg, #3b82f6, #60a5fa)",
            }} />
          </div>

          {/* Quick stats */}
          <div style={{ display: "flex", gap: 24, marginTop: 16, fontSize: 13 }}>
            <span style={{ color: "#22c55e" }}>● {doneItems} Done</span>
            <span style={{ color: "#3b82f6" }}>● {inProgressItems} In Progress</span>
            <span style={{ color: "#a8a29e" }}>● {totalItems - doneItems - inProgressItems} Remaining</span>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px" }}>

        {/* Section cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 32 }}>
          {sectionStats.map(s => (
            <div
              key={s.id}
              onClick={() => setActiveSection(activeSection === s.id ? null : s.id)}
              style={{
                background: "#fff", borderRadius: 10, padding: "16px 18px", cursor: "pointer",
                border: activeSection === s.id ? "2px solid #3b82f6" : "1px solid #e7e5e4",
                boxShadow: activeSection === s.id ? "0 0 0 3px #3b82f620" : "none",
                transition: "all 0.15s ease",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 20 }}>{s.icon}</span>
                <span style={{ fontSize: 22, fontWeight: 700, color: s.pct === 100 ? "#16a34a" : "#292524" }}>{s.pct}%</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 8, color: "#292524" }}>{s.title}</div>
              <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>{s.done}/{s.total} complete</div>
              <div style={{ marginTop: 10, background: "#f5f5f4", borderRadius: 4, height: 5, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${s.pct}%`, background: s.pct === 100 ? "#22c55e" : "#3b82f6", borderRadius: 4, transition: "width 0.3s" }} />
              </div>
            </div>
          ))}
        </div>

        {/* Expanded section detail */}
        {activeSection && (() => {
          const s = SECTIONS.find(x => x.id === activeSection);
          return (
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e7e5e4", marginBottom: 32, overflow: "hidden" }}>
              <div style={{ padding: "18px 20px", borderBottom: "1px solid #f5f5f4" }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{s.icon} {s.title}</div>
              </div>
              {s.items.map((item, i) => {
                const key = `${s.id}-${i}`;
                const status = state.items[key] || "not_started";
                const sc = statusColors[status];
                return (
                  <div key={key} style={{ padding: "12px 20px", borderBottom: "1px solid #fafaf9", display: "flex", alignItems: "center", gap: 12, background: i % 2 === 0 ? "#fff" : "#fafaf9" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc.dot, flexShrink: 0 }} />
                    <div style={{ flex: 1, fontSize: 13, color: status === "done" ? "#a8a29e" : "#292524", textDecoration: status === "done" ? "line-through" : "none" }}>{item}</div>
                    {adminMode ? (
                      <select value={status} onChange={e => setStatus(key, e.target.value)} style={{ fontSize: 11, padding: "3px 6px", borderRadius: 4, border: "1px solid #e7e5e4", fontFamily: "inherit", background: sc.bg, color: sc.text, cursor: "pointer" }}>
                        <option value="not_started">Not Started</option>
                        <option value="in_progress">In Progress</option>
                        <option value="done">Done</option>
                        <option value="blocked">Blocked</option>
                      </select>
                    ) : (
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: sc.bg, color: sc.text, fontWeight: 500 }}>
                        {status === "not_started" ? "Pending" : status === "in_progress" ? "Building" : status === "done" ? "Complete" : "Blocked"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Daily log */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e7e5e4", marginBottom: 32, overflow: "hidden" }}>
          <div style={{ padding: "18px 20px", borderBottom: "1px solid #f5f5f4", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>📋 Daily Updates</div>
            {todayLogs.length > 0 && <span style={{ fontSize: 11, background: "#eff6ff", color: "#2563eb", padding: "2px 8px", borderRadius: 4 }}>{todayLogs.length} today</span>}
          </div>

          {adminMode && (
            <div style={{ padding: "12px 20px", borderBottom: "1px solid #f5f5f4", display: "flex", gap: 8 }}>
              <input
                value={logInput}
                onChange={e => setLogInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addLog()}
                placeholder="What did you work on today?"
                style={{ flex: 1, fontSize: 13, padding: "8px 12px", border: "1px solid #e7e5e4", borderRadius: 6, fontFamily: "inherit", outline: "none" }}
              />
              <button onClick={addLog} style={{ fontSize: 13, padding: "8px 16px", background: "#1c1917", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Post</button>
            </div>
          )}

          {state.logs.length === 0 ? (
            <div style={{ padding: "24px 20px", textAlign: "center", color: "#a8a29e", fontSize: 13 }}>No updates posted yet.</div>
          ) : (
            state.logs.map((log, i) => {
              const d = new Date(log.date);
              const isToday = d.toDateString() === new Date().toDateString();
              return (
                <div key={i} style={{ padding: "12px 20px", borderBottom: "1px solid #fafaf9", display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: isToday ? "#3b82f6" : "#d6d3d1", marginTop: 6, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: "#292524", lineHeight: 1.5 }}>{log.text}</div>
                    <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>
                      {d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at {d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                    </div>
                  </div>
                  {adminMode && (
                    <button onClick={() => removeLog(i)} style={{ fontSize: 11, color: "#a8a29e", background: "none", border: "none", cursor: "pointer", padding: "4px" }}>✕</button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Admin toggle */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          {!adminMode ? (
            <div style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input
                type="password"
                value={adminPass}
                onChange={e => setAdminPass(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && adminPass === "trock2026") { setAdminMode(true); setAdminPass(""); }}}
                placeholder="Admin password"
                style={{ fontSize: 12, padding: "6px 10px", border: "1px solid #e7e5e4", borderRadius: 4, fontFamily: "inherit", width: 140 }}
              />
              <button
                onClick={() => { if (adminPass === "trock2026") { setAdminMode(true); setAdminPass(""); }}}
                style={{ fontSize: 12, padding: "6px 12px", background: "#1c1917", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
              >Unlock</button>
            </div>
          ) : (
            <button
              onClick={() => setAdminMode(false)}
              style={{ fontSize: 12, padding: "6px 16px", background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
            >Lock Admin Mode</button>
          )}
        </div>

        {/* Footer */}
        <div style={{ textAlign: "center", fontSize: 11, color: "#a8a29e", paddingBottom: 24 }}>
          Built by Adnaan Iqbal · Phase 1 · Live by May 15, 2026
        </div>
      </div>
    </div>
  );
}
