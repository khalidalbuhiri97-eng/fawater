import { serverAppPromise } from '../server.js';
import { waitUntil } from '@vercel/functions';
import { batchQueue } from '../server/batchQueue.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: any, res: any) {
  const app = await serverAppPromise;
  if (process.env.VERCEL && String(req.url || '').includes('/background/')) {
    waitUntil(batchQueue.processPendingQueues());
  }
  return app(req, res);
}
