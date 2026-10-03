const doctorSessionCaches = new Set();

export function createDoctorSessionCache() {
  const cache = new Map();
  doctorSessionCaches.add(cache);
  return cache;
}

export function clearDoctorSessionCaches() {
  for (const cache of doctorSessionCaches) cache.clear();
}
