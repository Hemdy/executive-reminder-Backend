const productionFrontendOrigin = 'https://executive-reminder-frontend.vercel.app';

export function getAllowedOrigins(): string[] {
  const configuredOrigins = process.env.FRONTEND_ORIGIN?.split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  const origins = new Set(configuredOrigins?.length ? configuredOrigins : [productionFrontendOrigin]);
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:4200');
  }
  return [...origins];
}
