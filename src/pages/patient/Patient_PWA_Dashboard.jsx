import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import { getStoredHealthTips, patientMatchesValue } from "../../lib/patientData";

const journeyWeeks = [
  { week: 16, date: "Jun 22 - Jun 28", title: "Week 16", note: "Early kicks begin" },
  { week: 17, date: "Jun 29 - Jul 5", title: "Week 17", note: "Growing stronger" },
  { week: 18, date: "Jul 6 - Jul 12", title: "Baby Movements", note: "Mother reports feeling baby move", icon: "ph:footprints-fill" },
  { week: 19, date: "Jul 13 - Jul 19", title: "Week 19", note: "Routine check-up" },
  { week: 20, date: "Jul 20 - Jul 26", title: "Week 20", note: "Anatomy scan" },
];

export default function PatientPWADashboard({ profile, onNavigate }) {
  const [activeWeek, setActiveWeek] = useState(profile.pregnancyWeek || 18);
  const [nextAppointment, setNextAppointment] = useState(null);
  const [recordsCount, setRecordsCount] = useState(0);
  const [healthTips, setHealthTips] = useState(getStoredHealthTips);

  const activeIndex = useMemo(
    () => journeyWeeks.findIndex((item) => item.week === activeWeek),
    [activeWeek]
  );

  const moveWeek = (direction) => {
    const nextIndex = Math.min(
      Math.max(activeIndex + direction, 0),
      journeyWeeks.length - 1
    );
    setActiveWeek(journeyWeeks[nextIndex].week);
  };

  useEffect(() => {
    let active = true;

    const loadDashboardData = async () => {
      const [scheduleResult, recordsResult] = await Promise.all([
        supabase
          .from("schedule")
          .select("id, patient_id, patient_name, doctor_name, title, start_time, status")
          .gte("start_time", new Date().toISOString())
          .order("start_time", { ascending: true }),
        supabase
          .from("medical_records")
          .select("id, patient_id, patient_name")
          .order("uploaded_at", { ascending: false }),
      ]);

      if (!active) return;

      if (!scheduleResult.error) {
        setNextAppointment(
          (scheduleResult.data || []).find(
            (row) =>
              patientMatchesValue(profile, row.patient_id) ||
              patientMatchesValue(profile, row.patient_name)
          ) || null
        );
      }

      if (!recordsResult.error) {
        setRecordsCount(
          (recordsResult.data || []).filter(
            (row) =>
              patientMatchesValue(profile, row.patient_id) ||
              patientMatchesValue(profile, row.patient_name)
          ).length
        );
      }
    };

    const syncHealthTips = () => setHealthTips(getStoredHealthTips());

    loadDashboardData();
    syncHealthTips();

    const scheduleChannel = supabase
      .channel("patient-dashboard-schedule")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "schedule" },
        loadDashboardData
      )
      .subscribe();

    const recordsChannel = supabase
      .channel("patient-dashboard-records")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medical_records" },
        loadDashboardData
      )
      .subscribe();

    window.addEventListener("storage", syncHealthTips);

    return () => {
      active = false;
      window.removeEventListener("storage", syncHealthTips);
      supabase.removeChannel(scheduleChannel);
      supabase.removeChannel(recordsChannel);
    };
  }, [profile]);

  const activeTip = healthTips[0] || null;
  const appointmentDate = nextAppointment?.start_time ? new Date(nextAppointment.start_time) : null;

  return (
    <section className="pwa-page pwa-dashboard-page">
      <div className="pwa-page-title">
        <h1>Dashboard</h1>
      </div>

      <section className="pwa-dashboard-hero">
        <div className="pwa-hero-copy">
          <h2>Welcome back, {profile.displayName || "Patient"}!</h2>
          <p>You&apos;re on your</p>
          <strong>
            <span>{profile.pregnancyWeek}th week</span> of pregnancy.
          </strong>
        </div>

        <div className="pwa-hero-illustration" aria-hidden="true">
          <span className="pwa-hero-person pwa-hero-mom">🤰</span>
          <span className="pwa-hero-person pwa-hero-doctor">👩‍⚕️</span>
          <span className="pwa-hero-person pwa-hero-nurse">🧑‍⚕️</span>
        </div>
      </section>

      <section className="pwa-journey-section">
        <h2>Your Pregnancy Journey</h2>

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
                onClick={() => setActiveWeek(item.week)}
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
      </section>

      <section className="pwa-health-tip-card">
        <div className="pwa-tip-image" aria-hidden="true">
          <Icon icon="healthicons:doctor-female-outline" />
        </div>

        <div className="pwa-tip-copy">
          <span>
            {appointmentDate
              ? `Next appointment: ${appointmentDate.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}, ${appointmentDate.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : `${recordsCount} medical record${recordsCount === 1 ? "" : "s"} on file`}
          </span>
          <h2>{activeTip?.title || "Doctor's Health Tip"}</h2>
          <p>
            {activeTip?.text ||
              "Daily health tips from your clinic will appear here once they are added."}
          </p>
        </div>

        <button type="button" onClick={() => onNavigate("reminders")}>
          View All Tips
          <Icon icon="solar:arrow-right-linear" />
        </button>
      </section>
    </section>
  );
}
