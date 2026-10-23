// `npm run mock-csip`: serve a default 5 kW import limit, plus a 3 kW limit
// that starts in 10 s and lasts 30 s. Browse http://localhost:8080/dcap.
import { MockCsipServer } from './mockCsipServer.js';

const now = Math.floor(Date.now() / 1000);
const server = new MockCsipServer({
    defaultImportLimit: { value: 5000, multiplier: 0 },
    controls: [
        // 3 x 10^3 = 3000 W
        { mRID: 'A1B2C3D4', start: now + 10, duration: 30, importLimit: { value: 3, multiplier: 3 } },
    ],
});
await server.listen(8080);
