do $identity$ begin
  if current_user <> 'postgres' or inet_server_addr() is not null
    or current_setting('audit_rehearsal.nonce',true) !~ '^[a-f0-9]{32}$'
    or current_database() is distinct from 'mc_audit_' || left(current_setting('audit_rehearsal.nonce',true),12)
    or current_setting('audit_rehearsal.major',true) is null
    or current_setting('server_version_num')::integer / 10000 <> current_setting('audit_rehearsal.major')::integer then
    raise exception 'STOP: not the approved isolated socket/database/version/nonce';
  end if;
end $identity$;
do $marker$ begin
  if not exists(select 1 from rehearsal_control.identity
      where nonce=current_setting('audit_rehearsal.nonce')) then
    raise exception 'STOP: rehearsal marker mismatch';
  end if;
end $marker$;
