// Where the bridge gets the site's import limit from.
//
// Two implementations:
//  - CsipClient (csipClient.ts): talks CSIP-AUS to the network itself. Used by
//    the demos against the mock server.
//  - OdeMqttSource (odeMqttSource.ts): listens to Open Dynamic Export's MQTT
//    output. ODE talks to the network (TLS, certificates, certification); we
//    just follow what it says.
//
// The interface only covers the limit side. Telemetry (posting readings back
// to the network) stays CsipClient-only: with ODE in front, ODE is the one
// talking to the network.
//
// The bridge owns the fail-safe, for both sources: if `lastUpdatedAt` is
// older than its comms-lost time, it ignores activeImportLimit() and applies
// defaultImportLimit() instead.

export interface ActiveLimit {
    importLimitW: number | undefined; // undefined = no limit applies
    source: 'control' | 'default' | 'none';
    mRID?: string; // which control, when source is 'control'
}

export interface LimitSource {
    /**
     * Bring the limits up to date. A polling source (CsipClient) fetches from
     * the server; a push source (MQTT) just checks that fresh data has been
     * arriving. Throws if it couldn't; the last good state is kept either way.
     */
    refresh(): Promise<void>;

    /** When the source last got good data, ms since epoch. 0 = never. */
    readonly lastUpdatedAt: number;

    /**
     * How long without good data before the source counts as lost, if the
     * source has an opinion (e.g. ODE publishes every second, so 10 s is a
     * lot). The bridge's own `commsLostAfterMs` option wins over this.
     */
    readonly commsLostAfterMs?: number;

    /** The import limit that applies now, from the last good data. No network calls. */
    activeImportLimit(): ActiveLimit;

    /** The default control from the last good data, ignoring scheduled controls. No network calls. */
    defaultImportLimit(): ActiveLimit;
}
