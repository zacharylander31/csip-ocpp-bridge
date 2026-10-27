// `npm run mock-csip`: serve a default 5 kW import limit, plus a 3 kW limit
// that starts in 10 s and lasts 30 s. Browse http://localhost:8080/dcap.
//
// Options (for running a real Open Dynamic Export against it):
//   --port 8130            listen here instead of 8080
//   --https                serve HTTPS with test-certs/mock-server.*.pem
//   --gateway-cert <file>  pre-register the gateway with this certificate's
//                          LFDI (e.g. test-certs/ode-device.cert.pem for ODE)
//   --control-in 10        seconds until the 3 kW control starts
//   --control-for 30       how long it lasts (seconds)
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { lfdiOf, MockCsipServer } from './mockCsipServer.js';

const { values: args } = parseArgs({
    options: {
        port: { type: 'string', default: '8080' },
        https: { type: 'boolean', default: false },
        'gateway-cert': { type: 'string' },
        'control-in': { type: 'string', default: '10' },
        'control-for': { type: 'string', default: '30' },
    },
});

const now = Math.floor(Date.now() / 1000);
const gatewayCert = args['gateway-cert'];
const server = new MockCsipServer(
    {
        defaultImportLimit: { value: 5000, multiplier: 0 },
        controls: [
            // 3 x 10^3 = 3000 W
            {
                mRID: 'A1B2C3D4',
                start: now + Number(args['control-in']),
                duration: Number(args['control-for']),
                importLimit: { value: 3, multiplier: 3 },
            },
        ],
    },
    {
        tls: args.https
            ? {
                  cert: readFileSync('test-certs/mock-server.cert.pem', 'utf8'),
                  key: readFileSync('test-certs/mock-server.key.pem', 'utf8'),
              }
            : undefined,
        gatewayLfdi: gatewayCert ? lfdiOf(readFileSync(gatewayCert, 'utf8')) : undefined,
    },
);
await server.listen(Number(args.port));
