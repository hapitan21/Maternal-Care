import { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { supabase } from '../../lib/supabaseClient';
import { getLogicalSessionIdentity } from '../../lib/roleInactivity';
import { getManilaDateKey } from '../../lib/appointmentDate';
import { basicAge, basicFields, blankBasic, buildBasicRegistrationRequest, validateBasic } from '../../lib/staffBasicRegistration';
import { basicRegistrationEnabled, createBasicRegistrationTransport } from '../../lib/staffBasicRegistrationTransport';
import '../../styles/staff-basic-registration.css';

const steps = ['Basic Information', 'Review Information', 'Patient Access & QR Code'].map((label, index) => ({ id: index + 1, label }));
const draftKey = 'maternal_staff_basic_registration_v1';
const emptyDraft = () => ({ basic: { ...blankBasic(), nationality: 'Filipino' }, operation: crypto.randomUUID(), request: null });
const clearLocalDraft = () => { try { sessionStorage.removeItem(draftKey); } catch { /* Storage may be unavailable; session fencing still applies. */ } };

// Real Staff component; transport availability is gated, not replaced with a mock.
export default function StaffBasicRegistrationWizard({ staffUserId, reservation, onSelectSlot, onBack, onComplete, BasicContent, ReviewContent, AccessContent, StepperContent, AsideContent, copyRegistrationValue, copyMessage, normalizeText }) {
  const [draft, setDraft] = useState(emptyDraft), [identity, setIdentity] = useState('');
  const [ready, setReady] = useState(false), [step, setStep] = useState(1), [errors, setErrors] = useState({});
  const [record, setRecord] = useState(null), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const fence = useRef(''), mounted = useRef(false), lock = useRef(false), requestRef = useRef(null);
  const enabled = basicRegistrationEnabled(import.meta.env);
  const fieldRefs = useRef({}), topRef = useRef(null);
  useEffect(() => {
    mounted.current = true;
    let active = true, eventVersion = 0;
    const accept = session => {
      if (!active) return;
      const key = session?.user?.id === staffUserId ? getLogicalSessionIdentity(session) : '';
      if (key === fence.current && key) return;
      fence.current = key; lock.current = false; requestRef.current = null;
      setIdentity(key); setBusy(false); setRecord(null); setConfirmed(false); setStep(1); setErrors({});
      let next = emptyDraft();
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
        if (key && saved?.identity === key && /^[0-9a-f-]{36}$/i.test(saved.operation || '') && saved.basic &&
            Object.entries(saved.basic).every(([field, value]) => basicFields.some(([name]) => name === field) && typeof value === 'string' && value.length <= 2000)) {
          if (saved.request) {
            const checked = buildBasicRegistrationRequest(saved.basic, { reviewed: true, doctorId: saved.request.doctor_id, reservationId: saved.request.reservation_id });
            if (JSON.stringify(checked) !== JSON.stringify(saved.request)) throw Error('Invalid recovered request');
          }
          next = saved;
        } else clearLocalDraft();
      } catch { clearLocalDraft(); }
      requestRef.current = next.request;
      setDraft(next); setReady(true);
      if (!key) setFeedback('An authenticated Staff session is required.');
      else setFeedback(next.request ? 'A registration was submitted. Reload its saved access details or retry the identical submission.' : '');
      if (next.request) setStep(2);
    };
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { eventVersion++; accept(session); });
    const version = eventVersion;
    const sessionTimer = setTimeout(() => {
      if (active && version === eventVersion) { setReady(true); setFeedback('Staff session lookup timed out. Return to Patients and retry.'); }
    }, 25000);
    void supabase.auth.getSession().then(({ data, error }) => {
      clearTimeout(sessionTimer);
      if (!active || version !== eventVersion) return;
      if (error) throw error;
      accept(data?.session);
    }).catch(() => { clearTimeout(sessionTimer); if (active) { setReady(true); setFeedback('Unable to load Staff session. Return to Patients and retry.'); } });
    return () => { clearTimeout(sessionTimer); active = false; mounted.current = false; fence.current = ''; data.subscription.unsubscribe(); };
  }, [staffUserId]);
  const persist = next => {
    setDraft(next);
    if (!identity) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify({ ...next, identity })); }
    catch { setFeedback('Browser draft recovery is unavailable. Keep this page open until registration is finished.'); }
  };
  const update = (key, value) => {
    const basic = { ...draft.basic, [key]: value };
    if (key === 'philHealthMember' && value !== 'Yes') basic.philHealthPin = '';
    setErrors(current => {
      if (!current[key] || validateBasic(basic)[key]) return current;
      const next = { ...current }; delete next[key]; return next;
    });
    persist({ ...draft, basic });
  };
  const review = () => {
    const invalid = validateBasic(draft.basic); setErrors(invalid);
    if (Object.keys(invalid).length) { fieldRefs.current[Object.keys(invalid)[0]]?.focus(); return false; }
    setStep(2); setFeedback('');
    return true;
  };
  const run = async action => {
    if (lock.current || !enabled || !identity || (action === 'finish' && !confirmed)) return;
    lock.current = true; setBusy(true); setFeedback('');
    const binding = identity;
    const current = () => mounted.current && fence.current === binding;
    try {
      let request = requestRef.current;
      if (!request) {
        if (reservation?.expiresAt && Date.parse(reservation.expiresAt) <= Date.now()) throw Error('Walk-in reservation expired. Choose another slot before submitting.');
        request = buildBasicRegistrationRequest(draft.basic, { reviewed: true, doctorId: reservation?.doctorId, reservationId: reservation?.reservationId });
        requestRef.current = request;
        persist({ ...draft, request }); // Freeze intent before the first network await; retry must be identical.
      }
      const transport = createBasicRegistrationTransport(supabase, enabled, binding, current);
      const result = action === 'finish' ? await transport.finish(draft.operation, request, record?.id) :
        action === 'read' ? await transport.read(draft.operation, request, record?.id) : await transport.save(draft.operation, request);
      if (!current()) return;
      setRecord(result); setStep(3);
      setFeedback(''); // The original confirmation screen already communicates verified success.
      if (result.registrationStatus === 'completed') {
        clearLocalDraft();
        onComplete(result);
      }
    } catch (error) {
      if (current()) setFeedback(['PGRST202', '42883'].includes(error.code) ?
        'The approved Basic-only backend is not installed. No legacy registration was attempted.' :
        `Registration outcome is unconfirmed: ${error.message || 'Request failed'}. Reload saved access details or retry the same operation.`);
    } finally { if (current()) { lock.current = false; setBusy(false); } }
  };
  const frozen = !!draft.request;
  const form = { ...draft.basic, age: !draft.basic.birthdate || validateBasic(draft.basic).birthdate ? '' : String(basicAge(draft.basic.birthdate, getManilaDateKey())) };
  const move = target => {
    if (busy || (frozen && target === 1)) return;
    if (target === 2 && step === 1) { if (!review()) return; }
    else if (target < step) setStep(target);
    topRef.current?.scrollIntoView({ block: 'start' });
  };
  return <section className="staff-register-page staff-basic-registration" ref={topRef} aria-busy={busy}>
    <div className="staff-register-shell">
      <div className="staff-register-workspace">
        <div className="staff-register-main-column">
          <button type="button" className="staff-back-btn" disabled={busy} onClick={() => onBack({ keepReservation: frozen })}>
            <Icon icon="solar:arrow-left-linear" aria-hidden="true" />Back to Patients
          </button>
          <div className="staff-register-top"><div>
            <h2>Register New Patient</h2>
            <p>Fill out the Patient information to create a new record.</p>
          </div></div>
          {step === 3 && record ? <div className="staff-register-completion-state" role="status">
            <Icon icon="solar:qr-code-bold" aria-hidden="true" /><span>
              <strong>Patient Access &amp; Confirmation</strong>
              <small>Registration details are saved; confirm the QR handoff to finish.</small>
            </span>
          </div> : <StepperContent currentStep={step} onStepSelect={move} items={steps} />}
          {feedback && !record && <p className="staff-patients-status-message" role="status" aria-live="polite">{feedback}</p>}
          {!!Object.keys(errors).length && <p className="staff-register-field-error" role="alert">Review the highlighted Basic Information fields.</p>}
          <main className="staff-register-main">
            {!ready ? <p role="status">Loading Staff session...</p> : <>
              {step === 1 && <fieldset className="staff-basic-controls" disabled={busy || frozen || !identity}>
                <BasicContent form={form} updateForm={update} normalizeFormField={key => update(key, normalizeText(draft.basic[key]))} updateBirthdate={value => update('birthdate', value)} registrationErrors={errors} setRegistrationFieldRef={key => node => { fieldRefs.current[key] = node; }} moveToRegistrationStep={move} />
              </fieldset>}
              {step === 2 && <ReviewContent form={form} selectedWalkInSlot={reservation} moveToRegistrationStep={move} editWalkInSlot={onSelectSlot} generatePatientAccess={() => void run('save')} isSavingPatient={busy} includeClinical={false} frozen={frozen} saveEnabled={enabled && !!identity} recoverAccess={frozen ? () => void run('read') : null} />}
              {step === 3 && record && <AccessContent accessCredentials={record} form={form} copyRegistrationValue={copyRegistrationValue} copyMessage={copyMessage} qrReceiptConfirmed={confirmed} setQrReceiptConfirmed={setConfirmed} backToEditRegistration={() => move(2)} isFinishingRegistration={busy} registrationRecord={{ registration_status: record.registrationStatus }} finishRegistration={() => void run('finish')} />}
            </>}
          </main>
          {feedback && record && <p className="staff-patients-status-message" role="status" aria-live="polite">{feedback}</p>}
        </div>
        <aside className="staff-register-side"><AsideContent generated={step === 3 && !!record} /></aside>
      </div>
    </div>
  </section>;
}
