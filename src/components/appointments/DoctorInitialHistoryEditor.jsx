import { useState } from "react";
import {
  allergyRecordFields, appendInitialHistory, bloodTypes, chooseInitialHistory,
  editInitialHistoryField, familySide, obstetricCountFields, pregnancyRecordFields,
  reproductiveFields, removePendingHistoryEntry, validateNewHistoryEntry,
} from "../../lib/doctorInitialHistoryDraft.js";

const visible = (value) => value == null || value === "" ? "Not recorded" : typeof value === "object" ? JSON.stringify(value) : String(value);
const legacyList = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
function Selector({ id, label, value, options, onChange, disabled, error }) {
  return <div className="appointment-visit-field">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>
      {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
    {error ? <span id={`${id}-error`} className="appointment-visit-field-error" role="alert">{error}</span> : null}
  </div>;
}
function SavedEntries({ rows, fields, caption }) {
  if (!Array.isArray(rows) || !rows.length) return <p className="appointment-visit-history-note">No saved entries recorded.</p>;
  return <div className="appointment-visit-table-wrap appointment-visit-history-table-wrap" tabIndex={0} role="region" aria-label={`${caption}, scroll horizontally for all fields`}>
    <table className="appointment-visit-table appointment-visit-history-table">
      <caption>{caption} — preserved; saved corrections require the guarded amendment workflow</caption>
      <thead><tr>{fields.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{fields.map(([key]) => <td key={key}>{visible(row?.[key])}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}
function PendingEntries({ domain, kind, field, onChange, draft, readOnly }) {
  return <ul className="appointment-visit-history-pending" aria-label="New unsaved history entries">
    {(domain.additions[field] || []).map((row, index) => <li key={row.id || index}>
      <span>{typeof row === "string" ? row : Object.entries(row).filter(([key]) => key !== "id").map(([key, value]) => `${key}: ${visible(value)}`).join("; ")}</span>
      <button type="button" className="appointment-visit-add-button" disabled={readOnly} onClick={() => onChange(removePendingHistoryEntry(draft, kind, field, index))} aria-label={`Remove unsaved ${field} entry ${index + 1}`}>Remove</button>
    </li>)}
  </ul>;
}
function RecordAdder({ kind, field, fields, label, draft, onChange, components, readOnly, onError }) {
  const [row, setRow] = useState({});
  const { TextField } = components;
  return <fieldset className="appointment-visit-history-entry">
    <legend>{label}</legend>
    <div className="appointment-visit-field-grid is-two-columns">
      {fields.map(([key, text, type]) => key === "type" ? <Selector key={key} id={`new-${field}-${key}`} label={text} value={row[key] || ""} disabled={readOnly}
        options={[["", "Select"], ...["medication", "food", "environmental", "insect", "latex", "chemical"].map((value) => [value, value])]}
        onChange={(value) => setRow((current) => ({ ...current, [key]: value }))} /> :
        <TextField key={key} id={`new-${field}-${key}`} label={text} type={type === "date" ? "date" : "text"} value={row[key] || ""} readOnly={readOnly}
          onChange={(value) => setRow((current) => ({ ...current, [key]: value }))} />)}
    </div>
    <button type="button" className="appointment-visit-add-button" disabled={readOnly} onClick={() => {
      try {
        const value = validateNewHistoryEntry({ id: globalThis.crypto.randomUUID(), ...row }, field);
        onChange(appendInitialHistory(draft, kind, field, value)); setRow({});
      } catch (error) { onError(error); }
    }}>Add {field === "pregnancy_records" ? "Past Pregnancy" : "Allergy"}</button>
    <PendingEntries domain={draft[kind]} kind={kind} field={field} draft={draft} onChange={onChange} readOnly={readOnly} />
  </fieldset>;
}
function ListAdder({ kind = "medical", field, label, prefix = "", draft, onChange, components, readOnly, onError }) {
  const [text, setText] = useState("");
  const { TextAreaField } = components;
  return <div className="appointment-visit-history-entry">
    <TextAreaField id={`new-${field}-${prefix || "entries"}`} label={label} value={text} size="compact" placeholder="One entered condition per line; leave blank if unknown" readOnly={readOnly} onChange={setText} />
    <button type="button" className="appointment-visit-add-button" disabled={readOnly} onClick={() => {
      const values = text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (!values.length) { onError(new Error("Enter a clinical fact before adding an entry.")); return; }
      let next = draft;
      for (const value of values) next = appendInitialHistory(next, kind, field, prefix ? `${prefix}: ${value}` : value);
      onChange(next); setText("");
    }}>Add {prefix || "Entries"}</button>
  </div>;
}

export default function DoctorInitialHistoryEditor({ context, draft, onChange, components, readOnly, localOnly = false, errors = {}, onError, edd, onEddChange }) {
  const { FormCard, TextField, TextAreaField } = components;
  const apply = (callback) => { try { onChange(callback()); } catch (error) { onError(error); } };
  const fieldInput = (definition) => {
    const [key, label, type] = definition, value = draft.obstetric.values[key];
    if (type === "boolean") return <Selector key={key} id={`history-${key}`} label={label} value={value == null || value === "" ? "" : String(value)}
      options={[["", "Unknown / not recorded"], ["true", "Yes"], ["false", "No"]]} disabled={readOnly || !["create", "select"].includes(draft.obstetric.action)} error={errors[`history-${key}`]}
      onChange={(next) => apply(() => editInitialHistoryField(draft, "obstetric", key, next))} />;
    return <TextField key={key} id={`history-${key}`} label={label} value={value ?? ""} type={type === "date" ? "date" : "text"} placeholder={type === "integer" ? "Unknown; enter 0 only if known" : "Not recorded"}
      readOnly={readOnly || !["create", "select"].includes(draft.obstetric.action)} error={errors[`history-${key}`]} onChange={(next) => apply(() => editInitialHistoryField(draft, "obstetric", key, next))} />;
  };
  const selection = (kind) => <Selector id={`history-${kind}-selection`} label={`Applicable ${kind === "obstetric" ? "Reproductive & Obstetric" : "Medical & Family"} History`} disabled={readOnly}
    value={draft[kind].action === "select" ? `select:${draft[kind].id}` : draft[kind].action}
    options={[["", "Choose explicitly"], ...context.state[kind].map((row, index) => [`select:${row.id}`, `Saved history ${index + 1} (${row.id.slice(0, 8)})`]),
      ...(context.state[kind].length ? [] : [["create", "Enter new clinical history"], ["not_recorded", "Not recorded (not a negative finding)"]]),
      ["retain_unresolved", "Retain unresolved; do not choose a row"]]}
    error={errors[`history-${kind}-selection`]} onChange={(value) => {
      apply(() => chooseInitialHistory(draft, kind, value, context));
      if (kind === "obstetric" && value.startsWith("select:")) {
        const saved = context.state.obstetric.find((row) => row.id === value.slice(7));
        if (saved?.expected_delivery_date) onEddChange(saved.expected_delivery_date);
      }
    }} />;
  const medical = draft.medical, obstetric = draft.obstetric;
  const medicalReadOnly = readOnly || !["create", "select"].includes(medical.action);
  const obstetricReadOnly = readOnly || !["create", "select"].includes(obstetric.action);
  const medicalKey = medical.id || medical.action, obstetricKey = obstetric.id || obstetric.action;
  return <div className="appointment-visit-history-editor">
    <FormCard title="Reproductive & Obstetric History" className="appointment-visit-history-card">
      <p className="appointment-visit-history-note">{localOnly ? "Local draft only; saving is unavailable until the versioned backend is activated. " : ""}Unknown values stay unset; no automatic Gravida, Para, Regular or Yes defaults.</p>
      {selection("obstetric")}
      <h3>Reproductive History</h3><div className="appointment-visit-field-grid is-two-columns appointment-visit-reproductive-fields">{reproductiveFields.map(fieldInput)}</div>
      <h3>Obstetric Index</h3><div className="appointment-visit-field-grid is-three-columns">{obstetricCountFields.map(fieldInput)}</div>
      <h3>Pregnancy Dates</h3><div className="appointment-visit-field-grid is-two-columns">
        {fieldInput(["last_menstrual_period", "Last Menstrual Period", "date"])}
        <TextField id="history-expected_delivery_date" label="Expected Delivery Date" type="date" value={edd || ""} readOnly={obstetricReadOnly} error={errors["history-expected_delivery_date"]} onChange={(value) => {
          apply(() => editInitialHistoryField(draft, "obstetric", "expected_delivery_date", value)); onEddChange(value);
        }} />
      </div>
      <p className="appointment-visit-history-note">EDD is shared with Pregnancy Status. Known dates cannot be cleared; changed dating needs explicit confirmation below.</p>
      <h3>Past Pregnancies</h3>
      <SavedEntries rows={obstetric.base.pregnancy_records} fields={pregnancyRecordFields} caption="Saved past pregnancies" />
      <RecordAdder key={`pregnancy-${obstetricKey}`} kind="obstetric" field="pregnancy_records" fields={pregnancyRecordFields} label="Add a past pregnancy" draft={draft} onChange={onChange} components={components} readOnly={obstetricReadOnly} onError={onError} />
    </FormCard>
    <FormCard title="Medical & Family History" className="appointment-visit-history-card">
      {selection("medical")}
      <Selector id="history-blood-type" label="Blood Type" value={draft.bloodType} disabled={readOnly} error={errors["history-blood-type"]}
        options={[["", "Unknown / not recorded"], ...(!bloodTypes.includes(draft.bloodType) && draft.bloodType ? [[draft.bloodType, `${draft.bloodType} (saved legacy value)`]] : []), ...bloodTypes.map((value) => [value, value])]}
        onChange={(value) => onChange({ ...draft, bloodType: value, bloodDirty: true, reviewed: false })} />
      <h3>Allergies</h3>
      <p className="appointment-visit-history-text">{Array.isArray(medical.base.allergies) && medical.base.allergies.length ? medical.base.allergies.map(visible).join("; ") : "Not recorded"}</p>
      <SavedEntries rows={medical.base.allergy_records} fields={allergyRecordFields} caption="Saved structured allergies" />
      <RecordAdder key={`allergy-${medicalKey}`} kind="medical" field="allergy_records" fields={allergyRecordFields} label="Add an allergy" draft={draft} onChange={onChange} components={components} readOnly={medicalReadOnly} onError={onError} />
      <ListAdder key={`allergy-text-${medicalKey}`} field="allergies" label="Additional allergy notes" draft={draft} onChange={onChange} components={components} readOnly={medicalReadOnly} onError={onError} />
      <PendingEntries domain={medical} kind="medical" field="allergies" draft={draft} onChange={onChange} readOnly={medicalReadOnly} />
      <h3>Medical Conditions</h3><p className="appointment-visit-history-text">{legacyList(medical.base.medical_conditions).map(visible).join("; ") || "Not recorded"}</p>
      <ListAdder key={`conditions-${medicalKey}`} field="medical_conditions" label="Additional medical conditions" draft={draft} onChange={onChange} components={components} readOnly={medicalReadOnly} onError={onError} />
      <PendingEntries domain={medical} kind="medical" field="medical_conditions" draft={draft} onChange={onChange} readOnly={medicalReadOnly} />
      <TextAreaField id="history-other_medical_condition" label="Other Medical Conditions" value={medical.values.other_medical_condition ?? ""} size="compact" readOnly={medicalReadOnly}
        onChange={(value) => apply(() => editInitialHistoryField(draft, "medical", "other_medical_condition", value))} />
      <h3>Maternal & Paternal Family History</h3>
      <div className="appointment-visit-field-grid is-two-columns">{["Mother", "Father"].map((side) => <section key={side}>
        <p className="appointment-visit-history-text"><strong>{side === "Mother" ? "Maternal" : "Paternal"} history:</strong> {familySide(medical.base.family_history, side).join("; ") || "Not recorded"}</p>
        <ListAdder key={`${side}-${medicalKey}`} field="family_history" prefix={side} label={`Additional ${side === "Mother" ? "maternal" : "paternal"} history`} draft={draft} onChange={onChange} components={components} readOnly={medicalReadOnly} onError={onError} />
      </section>)}</div>
      <p className="appointment-visit-history-text"><strong>Saved unassigned family history:</strong> {legacyList(medical.base.family_history).filter((value) => typeof value !== "string" || !/^(Mother|Father): /.test(value)).map(visible).join("; ") || "Not recorded"}</p>
      <PendingEntries domain={medical} kind="medical" field="family_history" draft={draft} onChange={onChange} readOnly={medicalReadOnly} />
      <TextAreaField id="history-other_family_history" label="Other / Unassigned Family History" value={medical.values.other_family_history ?? ""} size="compact" readOnly={medicalReadOnly}
        onChange={(value) => apply(() => editInitialHistoryField(draft, "medical", "other_family_history", value))} />
      <p className="appointment-visit-history-note">Saved list entries and unassigned legacy family values are preserved. Removing/correcting saved entries requires the blocked amendment workflow.</p>
    </FormCard>
    <FormCard title="Review Clinical History Intent">
      <Selector id="history-pregnancy-intent" label="Current Pregnancy Intent" disabled={readOnly} value={draft.pregnancy.action}
        options={[["", "Choose explicitly"], ...(context.state.context?.pregnancy_id ? [["confirm_existing", "Confirm the existing pregnancy identity"]] : [["establish_active", "Establish a reviewed active pregnancy"]]),
          ["retain_unresolved", "Retain unresolved pregnancy information"], ["not_recorded", "Pregnancy not recorded (not a negative diagnosis)"]]}
        error={errors["history-pregnancy-intent"]} onChange={(action) => onChange({ ...draft, pregnancy: { action, ...(action === "confirm_existing" ? { id: context.state.context.pregnancy_id } : {}) }, reviewed: false })} />
      <label className="appointment-visit-history-check" htmlFor="history-confirm-edd"><input id="history-confirm-edd" type="checkbox" checked={draft.confirmEdd} disabled={readOnly} onChange={(event) => onChange({ ...draft, confirmEdd: event.target.checked, reviewed: false })} />Explicitly confirm this EDD for the reviewed pregnancy (0–40-week Manila dating)</label>
      {errors["history-confirm-edd"] ? <p className="appointment-visit-field-error" role="alert">{errors["history-confirm-edd"]}</p> : null}
      <p className="appointment-visit-history-note">Obstetric: {obstetric.action || "not chosen"}; Medical: {medical.action || "not chosen"}; Pregnancy: {draft.pregnancy.action || "not chosen"}. Unknown is not a negative clinical finding.</p>
      <label className="appointment-visit-history-check" htmlFor="history-reviewed"><input id="history-reviewed" type="checkbox" checked={draft.reviewed} disabled={readOnly} onChange={(event) => onChange({ ...draft, reviewed: event.target.checked })} />I reviewed the exact patient, selected histories, entered facts and unknown states.</label>
      {errors["history-reviewed"] ? <p className="appointment-visit-field-error" role="alert">{errors["history-reviewed"]}</p> : null}
    </FormCard>
  </div>;
}
