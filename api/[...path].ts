import { serverAppPromise } from '../server.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: any, res: any) {
  const app = await serverAppPromise;
  return app(req, res);
}
