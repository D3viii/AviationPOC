import { useMemo, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";

type Tail = { tailNumber: string; colorHex: string };
type PilotInput = {
  name: string;
  onDays: number;
  offDays: number;
  preferredTail?: string; // optional
};

type Assignment = {
  date: string;          // YYYY-MM-DD
  pilotName: string;
  tailNumber: string;    // assigned tail
  status: "ON" | "OFF";
};

function toYMD(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + n);
  return x;
}

function generateSchedule(args: {
  startDate: string; // YYYY-MM-DD
  days: number;
  pilots: PilotInput[];
  tails: Tail[];
}) {
  const start = new Date(args.startDate + "T00:00:00");
  const tailsList = args.tails.map(t => t.tailNumber).filter(Boolean);

  // Each tail can have exactly ONE pair (2 pilots) per day
  const MAX_PAIRS_PER_TAIL_PER_DAY = 1;

  // key: `${date}__${tail}` -> pairs used (0/1)
  const dailyTailPairsUsed = new Map<string, number>();
  const getPairsUsed = (date: string, tail: string) =>
    dailyTailPairsUsed.get(`${date}__${tail}`) ?? 0;

  const incPairsUsed = (date: string, tail: string) => {
    const key = `${date}__${tail}`;
    const next = (dailyTailPairsUsed.get(key) ?? 0) + 1;
    dailyTailPairsUsed.set(key, next);
    return next;
  };

  let rr = 0;

  const pickTailForPair = (date: string, p1Pref?: string, p2Pref?: string) => {
    // Helper to test availability
    const canUse = (tail: string) =>
      tailsList.includes(tail) && getPairsUsed(date, tail) < MAX_PAIRS_PER_TAIL_PER_DAY;

    // 1) If both prefer the same tail and it's available, use it
    if (p1Pref && p2Pref && p1Pref === p2Pref && canUse(p1Pref)) {
      incPairsUsed(date, p1Pref);
      return p1Pref;
    }

    // 2) Otherwise, try either preference if available
    if (p1Pref && canUse(p1Pref)) {
      incPairsUsed(date, p1Pref);
      return p1Pref;
    }
    if (p2Pref && canUse(p2Pref)) {
      incPairsUsed(date, p2Pref);
      return p2Pref;
    }

    // 3) Otherwise round-robin to any available tail
    const attempts = tailsList.length;
    for (let i = 0; i < attempts; i++) {
      const tail = tailsList[(rr + i) % tailsList.length];
      if (canUse(tail)) {
        rr = (rr + i + 1) % tailsList.length;
        incPairsUsed(date, tail);
        return tail;
      }
    }

    // No tail available for another pair today
    return "EXTRA";
  };

  // Pre-create all assignments (default OFF), then fill ON/EXTRA per day
  const assignments: Assignment[] = [];

  // We'll store pilot ON/OFF per day so we can pair
  const statusByPilotByDay: { pilot: PilotInput; status: ("ON" | "OFF")[] }[] =
    args.pilots.map(pilot => {
      const cycle = Math.max(1, pilot.onDays + pilot.offDays);
      const status = Array.from({ length: args.days }, (_, i) => {
        const pos = i % cycle;
        return pos < pilot.onDays ? "ON" : "OFF";
      });
      return { pilot, status };
    });

  for (let dayIndex = 0; dayIndex < args.days; dayIndex++) {
    const date = toYMD(addDays(start, dayIndex));

    // Who is ON today?
    const onPilots = statusByPilotByDay
      .filter(x => x.status[dayIndex] === "ON")
      .map(x => x.pilot);

    // Pair them in order. If odd count, last is EXTRA (cannot staff a plane solo).
    const pairs: Array<[PilotInput, PilotInput]> = [];
    const extras: PilotInput[] = [];

    for (let i = 0; i < onPilots.length; i += 2) {
      const a = onPilots[i];
      const b = onPilots[i + 1];
      if (!b) {
        extras.push(a);
      } else {
        pairs.push([a, b]);
      }
    }

    // Assign each pair to a tail (ensuring tail gets exactly 2)
    const tailForPilot = new Map<string, string>(); // pilotName -> tail

    for (const [p1, p2] of pairs) {
      const tail = pickTailForPair(date, p1.preferredTail, p2.preferredTail);

      if (tail === "EXTRA") {
        // No tail capacity available today -> both become EXTRA
        tailForPilot.set(p1.name, "EXTRA");
        tailForPilot.set(p2.name, "EXTRA");
      } else {
        tailForPilot.set(p1.name, tail);
        tailForPilot.set(p2.name, tail);
      }
    }

    // Mark leftover ON pilots as EXTRA
    for (const p of extras) tailForPilot.set(p.name, "EXTRA");

    // Now emit assignments for ALL pilots for this date
    for (const row of statusByPilotByDay) {
      const pilot = row.pilot;
      const status = row.status[dayIndex];
      const tailNumber =
        status === "ON" ? (tailForPilot.get(pilot.name) ?? "EXTRA") : "";

      assignments.push({
        date,
        pilotName: pilot.name,
        status,
        tailNumber
      });
    }
  }

  return assignments;
}
function TailGridView(props: {
  tails: Tail[];
  assignments: Assignment[];
  startDate: string;
  days: number;
  showOff: boolean;
}) {
  const dayHeaders = useMemo(() => {
    const start = new Date(props.startDate + "T00:00:00");
    return Array.from({ length: props.days }, (_, i) => {
      const d = addDays(start, i);
      return { ymd: toYMD(d), label: d.getDate().toString() };
    });
  }, [props.startDate, props.days]);

  // Map: date+tail -> list of pilots ON that tail
  const cellMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of props.assignments) {
      if (a.status === "OFF" && !props.showOff) continue;
      if (a.status === "OFF") continue; // off days don't belong to a tail row
      const key = `${a.date}__${a.tailNumber}`;
      const arr = map.get(key) ?? [];
      arr.push(a.pilotName);
      map.set(key, arr);
    }
    return map;
  }, [props.assignments, props.showOff]);

  return (
    <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 8 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={thStyleSticky}>Tail</th>
            {dayHeaders.map(d => (
              <th key={d.ymd} style={thStyle}>{d.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.tails.map(t => (
            <tr key={t.tailNumber}>
              <td style={{ ...tdStyleSticky, borderLeft: `8px solid ${t.colorHex}` }}>
                <div style={{ fontWeight: 700 }}>{t.tailNumber}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{t.colorHex}</div>
              </td>

              {dayHeaders.map(d => {
                const key = `${d.ymd}__${t.tailNumber}`;
                const pilots = cellMap.get(key) ?? [];
                return (
                  <td key={key} style={tdStyle}>
                    {pilots.length > 0 ? pilots.join(", ") : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  borderBottom: "1px solid #ddd",
  padding: 8,
  minWidth: 42,
  textAlign: "center",
  background: "#fafafa",
  position: "sticky",
  top: 0,
  zIndex: 1
};

const thStyleSticky: React.CSSProperties = {
  ...thStyle,
  left: 0,
  zIndex: 2,
  textAlign: "left",
  minWidth: 160
};

const tdStyle: React.CSSProperties = {
  borderBottom: "1px solid #eee",
  borderRight: "1px solid #eee",
  padding: "6px 8px",
  verticalAlign: "top",
  height: 36,
  fontSize: 12,
  whiteSpace: "nowrap"
};

const tdStyleSticky: React.CSSProperties = {
  ...tdStyle,
  position: "sticky",
  left: 0,
  background: "white",
  zIndex: 1,
  minWidth: 160
};

export default function App() {
  const [view, setView] = useState<"calendar" | "grid">("calendar");

  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return toYMD(d);
  });
  const [days, setDays] = useState(60);
  const [showOff, setShowOff] = useState(false);

  // POC defaults (edit in UI later if you want)
  const [tails, setTails] = useState<Tail[]>([
    { tailNumber: "118DL", colorHex: "#22c55e" },
    { tailNumber: "808ME", colorHex: "#f97316" }
  ]);

  const [pilots, setPilots] = useState<PilotInput[]>([
    { name: "Rod", onDays: 15, offDays: 10, preferredTail: "118DL" },
    { name: "John", onDays: 15, offDays: 10, preferredTail: "808ME" },
    { name: "Dan", onDays: 10, offDays: 10, preferredTail: "" },
    { name: "Kyle", onDays: 10, offDays: 10, preferredTail: "" },
    { name: "Josh", onDays: 10, offDays: 10, preferredTail: "" },
    { name: "Jerry", onDays: 10, offDays: 10, preferredTail: "" },
  ]);

  const [assignments, setAssignments] = useState<Assignment[]>([]);

  const tailColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tails) m.set(t.tailNumber, t.colorHex);
    return m;
  }, [tails]);

  const fcEvents = useMemo(() => {
    return assignments
      .filter(a => showOff || a.status !== "OFF")
      .map(a => {
        const title =
          a.status === "OFF"
            ? `${a.pilotName} (OFF)`
            : `${a.tailNumber} — ${a.pilotName}`;

        // OFF days can be grey
        const color =
  a.status === "OFF"
    ? "#9ca3af"
    : a.tailNumber === "EXTRA"
      ? "#64748b"
      : (tailColor.get(a.tailNumber) ?? undefined);

        return {
          id: `${a.pilotName}_${a.date}_${a.tailNumber}_${a.status}`,
          title,
          start: a.date,
          allDay: true,
          backgroundColor: color,
          borderColor: color
        };
      });
  }, [assignments, showOff, tailColor]);

  const generate = () => {
    const cleanPilots = pilots
      .map(p => ({ ...p, name: p.name.trim() }))
      .filter(p => p.name.length > 0);

    const cleanTails = tails
      .map(t => ({ ...t, tailNumber: t.tailNumber.trim() }))
      .filter(t => t.tailNumber.length > 0);

    const a = generateSchedule({
      startDate,
      days: Math.max(7, Math.min(365, days)),
      pilots: cleanPilots,
      tails: cleanTails
    });

    setAssignments(a);
  };

  const updatePilot = (idx: number, patch: Partial<PilotInput>) => {
    setPilots(prev => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const updateTail = (idx: number, patch: Partial<Tail>) => {
    setTails(prev => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  };

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <h2 style={{ marginTop: 0 }}>Private Aviation Scheduling POC</h2>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <label>
          Start date{" "}
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
        </label>

        <label>
          Days{" "}
          <input
            type="number"
            value={days}
            min={7}
            max={365}
            onChange={e => setDays(Number(e.target.value))}
            style={{ width: 90 }}
          />
        </label>

        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showOff} onChange={e => setShowOff(e.target.checked)} />
          Show OFF days
        </label>

        <button onClick={generate} style={{ padding: "8px 12px" }}>
          Generate Schedule
        </button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setView("calendar")} style={{ padding: "8px 12px" }}>
            Calendar View
          </button>
          <button onClick={() => setView("grid")} style={{ padding: "8px 12px" }}>
            Tail Grid View
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Tails</h3>
            <button
              onClick={() => setTails(prev => [...prev, { tailNumber: "", colorHex: "#3b82f6" }])}
            >
              + Tail
            </button>
          </div>

          {tails.map((t, idx) => (
            <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 120px 44px", gap: 8, marginTop: 8 }}>
              <input
                placeholder="Tail (e.g. 118DL)"
                value={t.tailNumber}
                onChange={e => updateTail(idx, { tailNumber: e.target.value })}
              />
              <input
                placeholder="#22c55e"
                value={t.colorHex}
                onChange={e => updateTail(idx, { colorHex: e.target.value })}
              />
              <div style={{ width: 36, height: 32, borderRadius: 6, background: t.colorHex, border: "1px solid #ddd" }} />
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Pilots</h3>
            <button
              onClick={() => setPilots(prev => [...prev, { name: "", onDays: 7, offDays: 5, preferredTail: "" }])}
            >
              + Pilot
            </button>
          </div>

          {pilots.map((p, idx) => (
            <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px 1fr", gap: 8, marginTop: 8 }}>
              <input
                placeholder="Name"
                value={p.name}
                onChange={e => updatePilot(idx, { name: e.target.value })}
              />
              <input
                type="number"
                min={0}
                placeholder="On"
                value={p.onDays}
                onChange={e => updatePilot(idx, { onDays: Number(e.target.value) })}
              />
              <input
                type="number"
                min={0}
                placeholder="Off"
                value={p.offDays}
                onChange={e => updatePilot(idx, { offDays: Number(e.target.value) })}
              />
              <input
                placeholder="Preferred tail (optional)"
                value={p.preferredTail ?? ""}
                onChange={e => updatePilot(idx, { preferredTail: e.target.value })}
              />
            </div>
          ))}
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            Rotation is per pilot: ON for onDays, then OFF for offDays, repeating from the start date.
          </div>
        </div>
      </div>

      {view === "calendar" ? (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Calendar</h3>
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "dayGridMonth,timeGridWeek,timeGridDay"
            }}
            events={fcEvents}
            eventClick={(info) => alert(info.event.title)}
            height="auto"
          />
        </div>
      ) : (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Tail Grid</h3>
          <TailGridView
            tails={tails.filter(t => t.tailNumber.trim().length > 0)}
            assignments={assignments}
            startDate={startDate}
            days={days}
            showOff={showOff}
          />
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            Each cell shows pilots assigned to that tail on that day (ON days). OFF days are not placed in a tail row.
          </div>
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 12,
  background: "white",
  boxShadow: "0 1px 2px rgba(0,0,0,0.04)"
};
