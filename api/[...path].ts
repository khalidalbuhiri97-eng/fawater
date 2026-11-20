import { serverAppPromise } from '../server.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: any, res: any) {
  const app = await serverAppPromise;
  return await new Promise<void>((resolve, reject) => {
    res.once('finish', () => resolve());
    res.once('close', () => resolve());
    app(req, res, (err?: any) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
