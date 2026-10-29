const productionFrontendOrigin = 'https://executive-reminder-frontend.vercel.app';

export function getAllowedOrigins(): string[] {
  const configuredOrigins = process.env.FRONTEND_ORIGIN?.split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const origins = new Set(configuredOrigins?.length ? configuredOrigins : [productionFrontendOrigin]);
  origins.add('http://localhost:4200');
  origins.add('http://127.0.0.1:4200');
  return [...origins];
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }
  const cleanOrigin = origin.replace(/\/+$/, '');
  if (getAllowedOrigins().includes(cleanOrigin)) {
    return true;
  }
  // Allow all Vercel preview or branch deployments for executive-reminder-frontend
  return /^https:\/\/executive-reminder-frontend(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin);
}
