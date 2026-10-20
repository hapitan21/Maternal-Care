// Executes actual navigation/effect/submit handlers with synthetic state and mocked transports.
// No application client import, authenticated browser, or live database access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export async function verifyWizardReviewNavigation() {
  let assertions = 0;
  const check = (value, message) => { assert.ok(value, message); assertions++; };
  const patient = fs.readFileSync(new URL('../src/components/patient/PatientBookAppointment.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const staff = fs.readFileSync(new URL('../src/pages/staff/Staff_Patients.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const handler = (source, name) => {
    const match = source.match(new RegExp(`  const ${name} = [\\s\\S]*?\\n  };`));
    assert.ok(match, `Actual handler ${name}`); return match[0];
  };
  const plain = name => patient.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))[0];
  const doctor = { id:'synthetic-doctor-a', databaseId:'synthetic-doctor-a', name:'Synthetic Doctor A' };
  const otherDoctor = { id:'synthetic-doctor-b', databaseId:'synthetic-doctor-b', name:'Synthetic Doctor B' };
  const basePatient = () => ({ step:1, isEditingFromReview:false, serviceId:'prenatal',
    doctors:[doctor,otherDoctor], selectedDoctorId:doctor.id, isLoadingDoctors:false,
    selectedDate:'2030-01-02', selectedTime:'09:00', calendarMonth:new Date(2030,0,1), tomorrow:new Date(2030,0,2),
    profile:{recordId:'synthetic-patient'}, unavailableTimes:new Set(), rejectedSlotKeys:new Set(),
    isLoadingSlots:false, verifiedAvailabilityKey:'synthetic-patient:prenatal:synthetic-doctor-a:2030-01-02',
    slotRefreshKey:0, slotAvailabilityError:'', slotSelectionError:'', isSubmitting:false,
    isSubmitErrorSelectionBound:false, submitError:'', submittedAppointmentId:'' });
  let authCalls=0, writes=0, rpcResult={data:{id:'9001',request_id:'9001',status:'pending'},error:null};
  const p = vm.createContext({ state:basePatient(), useMemo:fn=>fn(), console:{error(){}},
    submitInFlightRef:{current:false}, unconfirmedBookingRef:{current:false},
    fetchUnavailableBookingTimes:async()=>new Set(),
    supabase:{auth:{getUser:async()=>{authCalls++;return {data:{user:{id:'synthetic-auth'}},error:null};}},
      rpc:async()=>{writes++;return rpcResult;}},
  });
  for (const key of Object.keys(p.state)) {
    p[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => {
      p.state[key] = typeof value==='function' ? value(p.state[key]) : value;
    };
  }
  p.useEffect = fn => { p.effect=fn; };
  vm.runInContext(patient.slice(patient.indexOf('const SERVICES ='), patient.indexOf('const INACTIVE_DOCTOR_STATUSES')), p);
  vm.runInContext(patient.slice(patient.indexOf('function startOfDay'), patient.indexOf('function getDoctorName')), p);
  for (const name of ['normalizeBookingRequestId','getSlotKey','getReadableBookingError','isUnavailableSlotError','isSelectionBoundBookingError']) {
    vm.runInContext(plain(name), p);
  }
  const derived = patient.slice(patient.indexOf('  const selectedService ='), patient.indexOf('  const clearSelectionBoundErrors'));
  const effect = patient.slice(patient.indexOf('  useEffect(() => {\n    if (step !== 3'), patient.indexOf('  const handleServiceSelect'));
  vm.runInContext(`function render(){const {${Object.keys(p.state).join(',')}}=state;
    ${derived}
    ${handler(patient,'clearSelectionBoundErrors')}
    ${effect}
    ${['handleServiceSelect','handleDoctorSelect','handleDateSelect','handleTimeSelect','submitBooking'].map(n=>handler(patient,n)).join('\n')}
    return {editFromReview,continueBooking,handleServiceSelect,handleDoctorSelect,handleDateSelect,handleTimeSelect,submitBooking,
      canContinue,hasCurrentAvailability,hasValidBookingDetails};}`, p);
  const render = () => p.render();
  const flush = () => new Promise(resolve=>setImmediate(resolve));
  const refresh = async () => { render();p.effect();await flush(); };
  for (const expected of [2,3,4]) {
    render().continueBooking();
    check(p.state.step===expected, 'Patient first-time progression unchanged');
  }
  for (const section of [1,2,3,1,3]) {
    const before={date:p.state.selectedDate,time:p.state.selectedTime,doctor:p.state.selectedDoctorId};
    render().editFromReview(section);
    check(p.state.step===section && p.state.isEditingFromReview, 'Patient selected edit section');
    check(!render().canContinue, 'Patient cannot confirm during availability refresh');
    await refresh(); render().continueBooking();
    check(p.state.step===4 && !p.state.isEditingFromReview, 'Patient edit returns directly to Review');
    check(p.state.selectedTime===before.time && p.state.selectedDate===before.date && p.state.selectedDoctorId===before.doctor,
      'Patient repeated edits retain selections');
  }
  render().editFromReview(1);render().handleServiceSelect('ultrasound');
  check(!render().hasCurrentAvailability, 'Service change invalidates availability receipt');
  await refresh();render().continueBooking();
  check(p.state.step===4 && p.state.serviceId==='ultrasound' && p.state.selectedTime==='09:00', 'Valid service edit preserves doctor/date/time');
  render().editFromReview(2);render().handleDoctorSelect(otherDoctor.id);
  await refresh();render().continueBooking();
  check(p.state.step===4 && p.state.selectedDoctorId===otherDoctor.id && p.state.selectedTime==='09:00', 'Available time retained after doctor edit');
  render().editFromReview(2);render().handleDoctorSelect(doctor.id);
  p.fetchUnavailableBookingTimes=async()=>new Set(['09:00']);
  await refresh();render().continueBooking();
  check(p.state.step===3 && p.state.selectedTime==='', 'Unavailable dependent time cleared and correction required');
  check(p.state.selectedDate==='2030-01-02' && p.state.serviceId==='ultrasound', 'Only invalid dependent selection cleared');
  check(!render().canContinue, 'Missing replacement time blocks return');
  render().handleTimeSelect('10:00');await refresh();render().continueBooking();
  check(p.state.step===4 && p.state.selectedTime==='10:00', 'Corrected time returns to Review');
  render().editFromReview(3);render().handleDateSelect(new Date(2030,0,3));
  await refresh();render().continueBooking();
  check(p.state.step===4 && p.state.selectedDate==='2030-01-03' && p.state.selectedTime==='10:00', 'Date edit revalidated with valid time retained');
  p.fetchUnavailableBookingTimes=async()=>{throw Error('Synthetic offline availability failure');};
  await refresh();
  check(!render().hasCurrentAvailability && p.state.slotAvailabilityError, 'Failed refresh cannot reuse a stale receipt');
  await render().submitBooking();
  check(writes===0 && authCalls===0, 'Invalid availability blocks submission before any transport');
  p.fetchUnavailableBookingTimes=async()=>new Set();await refresh();
  let resolveOld;
  p.fetchUnavailableBookingTimes=()=>new Promise(resolve=>{resolveOld=resolve;});
  render();const cancel=p.effect();
  cancel();render().handleDoctorSelect(otherDoctor.id);
  p.fetchUnavailableBookingTimes=async()=>new Set();await refresh();
  resolveOld(new Set(['10:00']));await flush();
  check(p.state.selectedTime==='10:00' && render().hasCurrentAvailability, 'Out-of-order availability result ignored');
  check(writes===0, 'No edit or return action creates a booking');
  await Promise.all([render().submitBooking(),render().submitBooking()]);
  check(writes===1 && authCalls===1 && p.state.submittedAppointmentId==='9001', 'Final submission uses existing single-flight RPC and receipt validation');
  p.state=basePatient();p.state.step=4;rpcResult={data:null,error:null};
  await render().submitBooking();const uncertainWrites=writes;
  render().editFromReview(1);await refresh();render().continueBooking();await render().submitBooking();
  check(writes===uncertainWrites && p.unconfirmedBookingRef.current, 'Edits cannot bypass uncertain-response duplicate protection');
  p.unconfirmedBookingRef.current=false;
  for (const invalid of [
    {serviceId:'not-a-service'}, {selectedDoctorId:'missing-doctor'}, {isLoadingDoctors:true},
    {selectedTime:''}, {selectedTime:'11:00'}, {selectedDate:'2000-01-02'},
    {verifiedAvailabilityKey:'previous-selection'}, {isLoadingSlots:true}, {slotAvailabilityError:'Synthetic error'},
  ]) {
    p.state={...basePatient(),step:4,...invalid};
    const before=writes;await render().submitBooking();
    check(writes===before && p.state.submitError, 'Invalid or unverified Patient edits cannot submit');
  }
  p.state={...basePatient(),step:3,profile:{}};
  let missingIdentityReads=0;p.fetchUnavailableBookingTimes=async()=>{missingIdentityReads++;return new Set();};
  await refresh();
  check(missingIdentityReads===0 && !render().hasCurrentAvailability && !!p.state.slotAvailabilityError,
    'Missing Patient ownership context fails closed before availability reads');

  const reservation={reservationId:'synthetic-reservation',doctorId:doctor.id,date:'2030-01-02',time:'09:00',expiresAt:'2030-01-02T10:00:00Z'};
  const s = vm.createContext({state:{step:1,registrationView:'form',isEditingRegistrationReview:false,
    form:{name:'Synthetic Patient',email:'patient@example.test',gravida:'2',para:'1',bloodType:'O+',clinical:{allergies:['synthetic']}},
    selectedWalkInSlot:reservation,statusMessage:''},invalidStep:0,validations:[],scrolls:0});
  for (const key of Object.keys(s.state)) s[`set${key[0].toUpperCase()}${key.slice(1)}`]=value=>{s.state[key]=value;};
  s.scrollRegistrationToTop=()=>{s.scrolls++;};
  s.validateRegistrationStep=number=>{
    s.validations.push(number);
    if(s.invalidStep===number){s.state.step=number;s.state.registrationView='form';return false;}
    return true;
  };
  vm.runInContext(staff.match(/const steps = \[[\s\S]*?\n\];/)[0],s);
  vm.runInContext(`function render(){const {step,registrationView,isEditingRegistrationReview}=state;
    ${['moveToRegistrationStep','reviewRegistration','editRegistrationFromReview','continueRegistrationStep'].map(n=>handler(staff,n)).join('\n')}
    return {moveToRegistrationStep,reviewRegistration,editRegistrationFromReview,continueRegistrationStep,count:steps.length};}`,s);
  const sr=()=>s.render();
  check(sr().count===3, 'Staff retains exactly three registration steps');
  sr().continueRegistrationStep(2);check(s.state.step===2, 'Normal Staff Step 1 advances to Step 2');
  sr().continueRegistrationStep(3);check(s.state.step===3, 'Normal Staff Step 2 advances to Step 3');
  sr().reviewRegistration();check(s.state.registrationView==='review' && s.state.step===3, 'Staff summary remains within three-step flow');
  for(const section of [1,2,3,1,2]) {
    sr().editRegistrationFromReview(section);
    check(s.state.step===section && s.state.isEditingRegistrationReview, 'Staff edit targets existing step');
    s.state.form.name=`Synthetic Edit ${section}`;
    const before=JSON.stringify(s.state.form);s.validations=[];
    if(section===3)sr().reviewRegistration();else sr().continueRegistrationStep(section+1);
    check(s.state.registrationView==='review' && s.state.step===3 && !s.state.isEditingRegistrationReview, 'Staff edit returns directly to existing summary');
    check(JSON.stringify(s.state.form)===before && s.state.form.email==='patient@example.test' && s.state.form.clinical.allergies.length===1, 'Staff demographics and clinical information persist');
    check(s.state.selectedWalkInSlot===reservation, 'Staff edit retains exact reservation object and expiration');
    check(s.validations.join(',')==='1,2,3', 'Staff return validates all three existing sections');
  }
  for(const invalid of [1,2,3]) {
    s.state.registrationView='review';s.state.step=3;sr().editRegistrationFromReview(invalid);
    s.invalidStep=invalid;sr().continueRegistrationStep(invalid+1);
    check(s.state.registrationView==='form' && s.state.step===invalid && s.state.isEditingRegistrationReview, 'Invalid Staff edit stays on invalid section');
    s.invalidStep=0;sr().continueRegistrationStep(invalid+1);
    check(s.state.registrationView==='review', 'Corrected Staff edit can return to summary');
  }
  sr().moveToRegistrationStep(1);sr().continueRegistrationStep(2);
  check(s.state.registrationView==='review', 'Staff stepper navigation from summary also retains return context');
  for(const name of ['editRegistrationFromReview','continueRegistrationStep','reviewRegistration','moveToRegistrationStep']) {
    check(!/supabase|release.*Reservation|persistWalkInSlot|setForm\(|setSelectedWalkInSlot|setRegistrationToken/.test(handler(staff,name)),
      'Staff navigation cannot mutate data, credentials or reservation');
  }
  check(/getStepOneValidationErrors\(form\)/.test(handler(staff,'validateRegistrationStep')) &&
    /getStepTwoValidationErrors\(form\)/.test(handler(staff,'validateRegistrationStep')), 'Staff existing validation functions retained');
  check(patient.includes('onClick={continueBooking}') && patient.includes('aria-label="Edit appointment type"') &&
    patient.includes('aria-label="Edit appointment time"'), 'Native accessible Patient edit/confirmation controls connected');
  check((staff.match(/isEditingRegistrationReview \? "Return to Review" : "Next"/g)||[]).length===3,
    'All three Staff forward controls expose return mode');
  check(patient.includes('step === 1 ? navigate("/patient/appointments") : setStep((current) => current - 1)'),
    'Patient normal Back and Cancel destinations retained');
  return assertions;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  console.log(`PASS: ${await verifyWizardReviewNavigation()} wizard navigation assertions; synthetic state/transports only.`);
}
