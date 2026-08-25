import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import {
  PatientPageHeader,
  PatientQuickLink,
  PatientSectionHeader,
} from "../../components/patient/PatientPwaUi";
import {
  getStoredHealthTips,
  patientMatchesValue,
} from "../../lib/patientData";

const pregnancyMilestones = {
  12: { title: "First Trimester", note: "Initial prenatal milestones", icon: "ph:baby-fill" },
  18: { title: "Baby Movements", note: "Mother may begin feeling baby move", icon: "ph:footprints-fill" },
  20: { title: "Anatomy Scan", note: "Common time for anatomy screening", icon: "solar:heart-pulse-bold" },
  28: { title: "Third Trimester", note: "Growth and wellness checks continue", icon: "solar:health-bold" },
  36: { title: "Birth Planning", note: "Prepare for delivery planning", icon: "solar:clipboard-heart-bold" },
};

function toPregnancyWeek(value) {
  const week = Number.parseInt(value, 10);
  return Number.isFinite(week) && week > 0 && week <= 45 ? week : null;
}

function getOrdinalWeek(week) {
  if (!week) return "";
  const mod100 = week % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : ["th", "st", "nd", "rd"][week % 10] || "th";
  return `${week}${suffix}`;
}

function parseDisplayDate(value) {
  if (!value || value === "Not provided") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function formatWeekRange(startDate) {
  if (!startDate) return "Dates pending";
  const endDate = addDays(startDate, 6);
  const startMonth = startDate.toLocaleDateString("en-US", { month: "short" });
  const endMonth = endDate.toLocaleDateString("en-US", { month: "short" });
  return startMonth === endMonth
    ? `${startMonth} ${startDate.getDate()} - ${endDate.getDate()}`
    : `${startMonth} ${startDate.getDate()} - ${endMonth} ${endDate.getDate()}`;
}

function buildJourneyWeeks(profile) {
  const currentWeek = toPregnancyWeek(profile.pregnancyWeek);
  if (!currentWeek) return [];

  const dueDate = parseDisplayDate(profile.dueDate);
  const pregnancyStart = dueDate ? addDays(dueDate, -280) : null;
  const firstWeek = Math.max(1, currentWeek - 2);
  const weeks = Array.from({ length: 5 }, (_, index) => firstWeek + index).filter(
    (week) => week <= 45
  );

  return weeks.map((week) => {
    const milestone = pregnancyMilestones[week] || {
      title: `Week ${week}`,
      note: week === currentWeek ? "Current pregnancy week" : "Pregnancy care continues",
      icon: "ph:baby-fill",
    };
    const weekStart = pregnancyStart ? addDays(pregnancyStart, (week - 1) * 7) : null;

    return {
      week,
      date: formatWeekRange(weekStart),
      ...milestone,
    };
  });
}

function mapHealthTipDatabaseRow(row) {
  const content = String(row?.content || "").trim();
  if (!content) return null;

  return {
    id: row.id,
    category: row.category || "General Health",
    title: row.title || row.category || "Health Tip",
    text: content,
    image: row.image_url || "",
  };
}

function dedupeHealthTips(tips) {
  return tips.filter(
    (tip, index, source) =>
      source.findIndex(
        (item) =>
          String(item.id || "") === String(tip.id || "") ||
          (String(item.title || "").trim().toLowerCase() ===
            String(tip.title || "").trim().toLowerCase() &&
            String(item.text || "").trim().toLowerCase() ===
              String(tip.text || "").trim().toLowerCase())
      ) === index
  );
}

export default function PatientPWADashboard({ profile, onNavigate }) {
  const currentWeek = toPregnancyWeek(profile.pregnancyWeek);
  const journeyWeeks = useMemo(() => buildJourneyWeeks(profile), [profile]);
  const [selectedWeek, setSelectedWeek] = useState("");
  const [healthTips, setHealthTips] = useState(() =>
    getStoredHealthTips({ includeDefaults: false })
  );
  const activeWeek = journeyWeeks.some((item) => item.week === selectedWeek)
    ? selectedWeek
    : currentWeek || "";

  const activeIndex = useMemo(
    () => journeyWeeks.findIndex((item) => item.week === activeWeek),
    [activeWeek, journeyWeeks]
  );

  const moveWeek = (direction) => {
    if (!journeyWeeks.length) return;
    const nextIndex = Math.min(
      Math.max((activeIndex >= 0 ? activeIndex : 0) + direction, 0),
      journeyWeeks.length - 1
    );
    setSelectedWeek(journeyWeeks[nextIndex].week);
  };

  useEffect(() => {
    let active = true;

    const loadDashboardData = async () => {
      const { data, error } = await supabase
        .from("health_tips")
        .select("*")
        .eq("is_active", true)
        .order("published_at", { ascending: false })
        .order("created_at", { ascending: false });

      if (!active) return;

      if (error) {
        console.warn("Patient dashboard health tips fetch failed:", error.message);
        setHealthTips((currentTips) =>
          currentTips.length
            ? currentTips
            : getStoredHealthTips({ includeDefaults: false })
        );
        return;
      }

      const databaseTips = (data || [])
        .filter(
          (row) =>
            !row.patient_id ||
            patientMatchesValue(profile, row.patient_id) ||
            Boolean(profile.recordId && row.patient_id === profile.recordId)
        )
        .map(mapHealthTipDatabaseRow)
        .filter(Boolean);

      setHealthTips(
        dedupeHealthTips([
          ...databaseTips,
          ...getStoredHealthTips({ includeDefaults: false }),
        ])
      );
    };

    const syncHealthTips = () =>
      setHealthTips((currentTips) =>
        dedupeHealthTips([
          ...currentTips,
          ...getStoredHealthTips({ includeDefaults: false }),
        ])
      );

    loadDashboardData();
    syncHealthTips();

    const healthTipsChannel = supabase
      .channel("patient-dashboard-health-tips")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "health_tips" },
        loadDashboardData
      )
      .subscribe();

    window.addEventListener("storage", syncHealthTips);

    return () => {
      active = false;
      window.removeEventListener("storage", syncHealthTips);
      supabase.removeChannel(healthTipsChannel);
    };
  }, [profile]);

  const activeTip = healthTips[0] || null;

  return (
    <section className="pwa-page pwa-dashboard-page">
      <PatientPageHeader
        title="Dashboard"
        subtitle="Your pregnancy overview and latest care updates."
      />

      <section className="pwa-dashboard-hero">
        <div className="pwa-hero-copy">
          <span className="pwa-hero-eyebrow">Pregnancy overview</span>
          <h2>Welcome back, {profile.displayName || "Patient"}!</h2>
          {currentWeek ? (
            <>
              <p>You&apos;re on your</p>
              <strong>
                <span>{getOrdinalWeek(currentWeek)} week</span> of pregnancy.
              </strong>
            </>
          ) : (
            <>
              <p>Your pregnancy journey</p>
              <strong className="pwa-hero-week-missing">will appear here.</strong>
              <small className="pwa-hero-helper">
                Your clinic will update this after your pregnancy details are recorded.
              </small>
            </>
          )}
        </div>

        <div className="pwa-hero-illustration" aria-hidden="true">
          <img src="/images/dashboard-hero-people.png" alt="" />
          <span className="pwa-hero-person pwa-hero-mom">🤰</span>
          <span className="pwa-hero-person pwa-hero-doctor">👩‍⚕️</span>
          <span className="pwa-hero-person pwa-hero-nurse">🧑‍⚕️</span>
        </div>
      </section>

      <section className="pwa-dashboard-shortcuts" aria-labelledby="pwa-quick-access-title">
        <PatientSectionHeader
          id="pwa-quick-access-title"
          title="Quick access"
          subtitle="Open the information you use most."
        />
        <div className="pwa-dashboard-shortcut-grid">
          <PatientQuickLink
            icon="solar:document-medicine-bold-duotone"
            title="Medical records"
            helper="Review clinic findings"
            onClick={() => onNavigate("medical-record")}
          />
          <PatientQuickLink
            icon="solar:calendar-mark-bold-duotone"
            title="Appointments"
            helper="Check upcoming visits"
            onClick={() => onNavigate("appointments")}
          />
          <PatientQuickLink
            icon="solar:bell-bing-bold-duotone"
            title="Reminders"
            helper="View medicines and tips"
            onClick={() => onNavigate("reminders")}
          />
        </div>
      </section>

      <section className="pwa-journey-section" aria-labelledby="pwa-journey-title">
        <PatientSectionHeader
          id="pwa-journey-title"
          title="Your pregnancy journey"
          subtitle={currentWeek ? `You are currently in week ${currentWeek}.` : "Weekly milestones will appear here."}
        />

        {journeyWeeks.length ? (
          <div className="pwa-journey-carousel">
          <button
            type="button"
            className="pwa-round-arrow"
            onClick={() => moveWeek(-1)}
            aria-label="Previous week"
          >
            <Icon icon="solar:alt-arrow-left-linear" />
          </button>

          <div className="pwa-week-row">
            {journeyWeeks.map((item) => (
              <button
                type="button"
                key={item.week}
                className={`pwa-week-card ${activeWeek === item.week ? "is-active" : ""}`}
                  onClick={() => setSelectedWeek(item.week)}
              >
                {activeWeek === item.week ? (
                  <Icon className="pwa-week-icon" icon={item.icon || "ph:baby-fill"} />
                ) : (
                  <span>Week</span>
                )}
                <strong>{item.week}</strong>
                {activeWeek === item.week ? <b>Week {item.week}</b> : null}
                <small>{activeWeek === item.week ? item.title : item.date}</small>
                {activeWeek === item.week ? <em>{item.note}</em> : null}
                {activeWeek === item.week ? (
                  <i aria-hidden="true"><Icon icon="solar:check-circle-bold" /></i>
                ) : null}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="pwa-round-arrow"
            onClick={() => moveWeek(1)}
            aria-label="Next week"
          >
            <Icon icon="solar:alt-arrow-right-linear" />
          </button>
          </div>
        ) : (
          <div className="pwa-empty-card pwa-journey-empty" role="status">
            <span aria-hidden="true">
              <Icon icon="solar:calendar-mark-bold-duotone" />
            </span>
            <div>
              <h2>Pregnancy journey is being prepared</h2>
              <p>Your weekly milestones will appear after your clinic records your current pregnancy week.</p>
            </div>
          </div>
        )}
      </section>

      <section className="pwa-health-tip-card">
        <div className="pwa-tip-image" aria-hidden="true">
          <Icon icon="healthicons:doctor-female-outline" />
        </div>

        <div className="pwa-tip-copy">
          <span>Doctor&apos;s Health Tip</span>
          <h2>{activeTip?.title || "Doctor's Health Tip"}</h2>
          <p>
            {activeTip?.text ||
              "Daily health tips from your clinic will appear here once they are added."}
          </p>
        </div>

        <div className="pwa-tip-actions">
          <button type="button" onClick={() => onNavigate("reminders")}>
            View All Tips
            <Icon icon="solar:arrow-right-linear" />
          </button>
        </div>
      </section>
    </section>
  );
}
