// In-memory fixtures only: no runtime packet, Docker operations, SQL or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetDir, composeFiles, validateComposeFiles, assertComposeRuntime, digest } from './admin-audit-cp4-compose.mjs';

export function assertCp4NetworkContracts(packet, workspace) {
  let checks = 0;
  const check = value => { assert.ok(value); checks++; };
  const rejects = fn => { assert.throws(fn); checks++; };
  const config = JSON.parse(packet.files['compose.json']), manifest = packet.manifest;
  const services = Object.keys(config.services), nonce = manifest.nonce;
  check(Object.keys(config.networks).sort().join(',') === 'gateway,isolated');
  check(config.networks.isolated.internal === true && config.networks.gateway.internal === false);
  for (const [name, network] of Object.entries(config.networks)) {
    check(network.driver === 'bridge' && !network.external && network.labels['maternal.audit.cp4.nonce'] === nonce);
    check(network.name === (name === 'isolated' ? manifest.network : manifest.gatewayNetwork));
    check(network.driver_opts['com.docker.network.bridge.host_binding_ipv4'] === '127.0.0.1');
  }
  const aliases = { db: ['db','db.supabase.internal'], auth: ['auth'], rest: ['rest'],
    realtime: ['realtime','realtime-dev'], kong: ['kong','api.supabase.internal'] };
  for (const [name, service] of Object.entries(config.services)) {
    check(Object.keys(service.networks).sort().join(',') === (name === 'kong' ? 'gateway,isolated' : 'isolated'));
    check(JSON.stringify(service.networks.isolated.aliases) === JSON.stringify(aliases[name]));
    check(name === 'kong' ? JSON.stringify(service.ports) === JSON.stringify([
      {target:8000,published:'55421',host_ip:'127.0.0.1',protocol:'tcp'}]) : !service.ports);
  }
  check(fs.readFileSync(path.join(assetDir,'compose.json'),'utf8') ===
    packet.files['compose.json'].replaceAll(nonce,'__CP4_NONCE__'));
  check(fs.readFileSync(path.join(assetDir,'runtime-manifest.json'),'utf8') ===
    (JSON.stringify(manifest,null,2)+'\n').replaceAll(nonce,'__CP4_NONCE__'));
  const sealed = { version:2,runtime:'docker-compose',syntheticOnly:true,nonce,
    files:Object.fromEntries(Object.entries(packet.files).map(([name,content])=>[name,digest(content)])) };
  check(validateComposeFiles(sealed, name=>packet.files[name]).gatewayNetwork === manifest.gatewayNetwork);
  for (const mutate of [
    c=>{delete c.networks.gateway;},
    c=>{c.networks.gateway.internal=true;},
    c=>{c.networks.isolated.internal=false;},
    c=>{c.networks.gateway.external=true;},
    c=>{c.networks.gateway.name='foreign-network';},
    c=>{c.networks.gateway.labels['maternal.audit.cp4.nonce']='foreign';},
    c=>{c.networks.foreign={driver:'bridge'};},
    c=>{delete c.services.kong.networks.gateway;},
    c=>{delete c.services.kong.networks.isolated;},
    ...['db','auth','rest','realtime'].map(name=>c=>{c.services[name].networks.gateway={};}),
    ...['0.0.0.0','::','::1',''].map(host=>c=>{c.services.kong.ports[0].host_ip=host;}),
    c=>{c.services.kong.ports=[];},
    c=>{c.services.db.ports=[{target:5432,published:'54322',host_ip:'127.0.0.1'}];},
  ]) {
    const opened = structuredClone(config); mutate(opened);
    const content = JSON.stringify(opened), plan = structuredClone(sealed);
    plan.files['compose.json'] = digest(content);
    rejects(()=>validateComposeFiles(plan,name=>name==='compose.json'?content:packet.files[name]));
  }
  const observed = { localSocket:true,
    resources:{containers:services.map(name=>`${manifest.project}-${name}-1`),
      networks:[manifest.network,manifest.gatewayNetwork],volumes:[manifest.volume]},
    networks:[
      {Name:manifest.network,Driver:'bridge',Internal:true,project:manifest.project,nonce,
        Containers:services.map(name=>`${manifest.project}-${name}-1`)},
      {Name:manifest.gatewayNetwork,Driver:'bridge',Internal:false,project:manifest.project,nonce,
        Containers:[`${manifest.project}-kong-1`]},
    ],
    volume:{Name:manifest.volume,nonce},
    containers:services.map(service=>({service,name:`${manifest.project}-${service}-1`,nonce,
      image:config.services[service].image,running:true,healthy:true,
      networks:service==='kong'?[manifest.network,manifest.gatewayNetwork]:[manifest.network],
      volumes:service==='db'?[manifest.volume]:[],
      bindings:service==='kong'?[{host:'127.0.0.1',port:'55421',target:'8000/tcp'}]:[],
      binds:service==='db'?[{source:path.join(workspace,'db-start.sh'),destination:'/cp4/db-start.sh',readOnly:true}]:
        service==='kong'?[{source:path.join(workspace,'private/kong.json'),destination:'/cp4/kong.json',readOnly:true}]:[],
    })),
  };
  assertComposeRuntime(manifest,observed,workspace); checks++;
  const reordered = structuredClone(observed);
  reordered.networks.reverse(); reordered.containers.reverse();
  reordered.resources.networks.reverse(); reordered.resources.containers.reverse();
  reordered.containers.forEach(c=>c.networks.reverse());
  assertComposeRuntime(manifest,reordered,workspace); checks++;
  const kong = state=>state.containers.find(c=>c.service==='kong');
  for (const mutate of [
    x=>{x.localSocket=false;},
    ...['containers','networks','volumes'].flatMap(kind=>[
      x=>{x.resources[kind].push('unexpected-project-resource');},
      x=>{x.resources[kind].pop();},
    ]),
    x=>{x.networks.pop();},
    x=>{x.networks.push(structuredClone(x.networks[0]));},
    x=>{x.networks[1].Name='foreign-network';},
    ...[0,1].flatMap(i=>[
      x=>{x.networks[i].Internal=!x.networks[i].Internal;},
      x=>{x.networks[i].Driver='overlay';},
      x=>{x.networks[i].project='foreign-project';},
      x=>{delete x.networks[i].nonce;},
      x=>{x.networks[i].Containers.push('protected-container');},
    ]),
    x=>{x.networks[0].Containers.pop();},
    x=>{x.networks[1].Containers=[];},
    x=>{kong(x).networks=[manifest.network];},
    x=>{kong(x).networks=[manifest.gatewayNetwork];},
    ...services.map(name=>x=>{x.containers.find(c=>c.service===name).networks.push('bridge');}),
    ...['db','auth','rest','realtime'].flatMap(name=>[
      x=>{x.containers.find(c=>c.service===name).networks.push(manifest.gatewayNetwork);},
      x=>{x.networks[1].Containers.push(`${manifest.project}-${name}-1`);},
      x=>{x.containers.find(c=>c.service===name).bindings.push({host:'127.0.0.1',port:'54322',target:'5432/tcp'});},
    ]),
    x=>{kong(x).bindings=[];}, // Requested HostConfig binding is insufficient when effective Ports is empty.
    ...['0.0.0.0','::','::1',''].map(host=>x=>{kong(x).bindings[0].host=host;}),
    x=>{kong(x).bindings[0].port='55422';},
    x=>{kong(x).bindings[0].target='8001/tcp';},
    x=>{kong(x).bindings.push({...kong(x).bindings[0]});},
    x=>{x.volume.Name='supabase_db_old';},
    x=>{x.volume.nonce='foreign';},
    x=>{x.containers.push(structuredClone(x.containers[0]));},
    x=>{x.containers[0].healthy=false;},
    x=>{x.containers[0].running=false;},
    x=>{x.containers[0].nonce='other';},
    x=>{x.containers[0].image='postgres:17';},
    x=>{x.containers[0].volumes.push('old-volume');},
    x=>{x.containers[0].binds[0].readOnly=false;},
    x=>{kong(x).binds.push({source:'/foreign',destination:'/foreign',readOnly:true});},
  ]) {
    const copy = structuredClone(observed); mutate(copy);
    rejects(()=>assertComposeRuntime(manifest,copy,workspace));
  }
  return checks;
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const nonce = '0123456789abcdef0123456789abcdef';
  const packet = composeFiles(nonce,'-- Synthetic network fixture; never execute.',1700000000);
  const checks = assertCp4NetworkContracts(packet,path.join(os.tmpdir(),`mc-audit-cp4-compose-${nonce}`));
  console.log(`PASS: ${checks} CP4 network assertions; 0 failures. In-memory fixtures only; no disk packet, Docker or SQL.`);
}
