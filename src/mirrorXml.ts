// XML for CSIP-AUS telemetry: the MirrorUsagePoints the gateway registers once
// (one for the chargers, one for the site meter), and the MirrorMeterReadings
// it posts to them every postRate.
//
// IEEE 2030.5 servers validate against the schema, which fixes element order,
// so the order here matters. Shapes and codes follow Open Dynamic Export
// (src/sep2/models/mirrorUsagePoint.ts, mirrorMeterReading.ts and
// helpers/mirrorUsagePointBase.ts).
import { createHash } from 'node:crypto';

const SEP = 'urn:ieee:std:2030.5:ns';

// roleFlags bits: 0 isMirror (we're not the meter, we're reporting for it),
// 1 isPremisesAggregationPoint (the site connection point), 2 isPEV (an EV),
// 3 isDER ("capable of delivering power to the grid"), 6 isSubmeter (not the
// site connection point). ODE's inverter mirror is 0x49 (mirror+DER+submeter).
export type MirrorKind = 'chargers' | 'site';

interface MirrorDefinition {
    roleFlags: number;
    description: string;
    readingDescription: string; // also seeds the reading's mRID, so never change it
}

const MIRRORS: Record<MirrorKind, MirrorDefinition> = {
    // A one-way charger can't export, so this uses isPEV instead of isDER:
    // 0x01 + 0x04 + 0x40 = 0x45.
    // TODO: confirm which roleFlags networks expect for EV chargers.
    chargers: {
        roleFlags: 0x45,
        description: 'EV chargers',
        readingDescription: 'EV chargers average real power (W)',
    },
    // The site connection point: mirror + premises aggregation point = 0x03,
    // the same as ODE's site mirror. Net power: negative when exporting.
    site: {
        roleFlags: 0x03,
        description: 'Site measurement',
        readingDescription: 'Site average real power (W) - net',
    },
};

// The last 8 hex digits of every mRID are the device maker's IANA Private
// Enterprise Number (PEN). All zeros until there's a real one.
export const PLACEHOLDER_PEN = '00000000';

// ReadingType codes (IEEE 2030.5 enums):
const COMMODITY_ELECTRICITY = 1; // electricity, secondary metered (low-voltage side)
const DATA_QUALIFIER_AVERAGE = 2;
// Forward = delivered to the customer = import is positive. ODE uses forward
// for its site mirror too; its DER mirror uses 19 (reverse) for generation.
const FLOW_FORWARD = 1;
const KIND_POWER = 37;
const UOM_WATTS = 38;
// phase is left out: 0 ("not applicable") is valid, but ODE found the Energex
// server rejects it, and leaving it out means the same thing.

export interface MirrorReading {
    avgW: number;
    startSec: number; // unix seconds, server clock
    durationSec: number;
}

/** The MirrorUsagePoint to POST to the server's MirrorUsagePointList (/mup). */
export function mirrorUsagePointXml(kind: MirrorKind, lFDI: string, pen: string): string {
    const m = MIRRORS[kind];
    // The server must know up front what each reading will be, so the
    // MirrorUsagePoint carries one MirrorMeterReading with only a ReadingType.
    return `<?xml version="1.0" encoding="UTF-8"?>
<MirrorUsagePoint xmlns="${SEP}">
    <mRID>${usagePointMrid(m, lFDI, pen)}</mRID>
    <description>${m.description}</description>
    <roleFlags>${hex2(m.roleFlags)}</roleFlags>
    <serviceCategoryKind>0</serviceCategoryKind>
    <status>1</status>
    <deviceLFDI>${lFDI}</deviceLFDI>
    <MirrorMeterReading>
        <mRID>${readingMrid(m, pen)}</mRID>
        <description>${m.readingDescription}</description>
        ${readingTypeXml(0)}
    </MirrorMeterReading>
</MirrorUsagePoint>`;
}

/** One average-power reading to POST to a MirrorUsagePoint (/mup/N). */
export function mirrorMeterReadingXml(kind: MirrorKind, pen: string, r: MirrorReading): string {
    const m = MIRRORS[kind];
    const { value, multiplier } = toInt16(r.avgW);
    const end = r.startSec + r.durationSec;
    return `<?xml version="1.0" encoding="UTF-8"?>
<MirrorMeterReading xmlns="${SEP}">
    <mRID>${readingMrid(m, pen)}</mRID>
    <description>${m.readingDescription}</description>
    <lastUpdateTime>${end}</lastUpdateTime>
    <nextUpdateTime>${end + r.durationSec}</nextUpdateTime>
    <Reading>
        <timePeriod>
            <duration>${r.durationSec}</duration>
            <start>${r.startSec}</start>
        </timePeriod>
        <value>${value}</value>
    </Reading>
    ${readingTypeXml(multiplier, r.durationSec)}
</MirrorMeterReading>`;
}

function readingTypeXml(powerOfTenMultiplier: number, intervalLengthSec?: number): string {
    const interval = intervalLengthSec === undefined ? '' : `\n            <intervalLength>${intervalLengthSec}</intervalLength>`;
    return `<ReadingType>
            <commodity>${COMMODITY_ELECTRICITY}</commodity>
            <dataQualifier>${DATA_QUALIFIER_AVERAGE}</dataQualifier>
            <flowDirection>${FLOW_FORWARD}</flowDirection>${interval}
            <kind>${KIND_POWER}</kind>
            <powerOfTenMultiplier>${powerOfTenMultiplier}</powerOfTenMultiplier>
            <uom>${UOM_WATTS}</uom>
        </ReadingType>`;
}

/**
 * Reading values are 16-bit integers (-32768..32767), so 40 kW won't fit as
 * watts. Raise the power of ten until it does: 40000 W -> 4000 x 10^1.
 */
export function toInt16(watts: number): { value: number; multiplier: number } {
    if (!Number.isFinite(watts)) throw new Error(`reading must be a finite number, got ${watts}`);
    let multiplier = 0;
    let value = Math.round(watts);
    while (value < -32768 || value > 32767) {
        multiplier++;
        value = Math.round(watts / 10 ** multiplier);
    }
    return { value, multiplier };
}

// mRIDs are 128 bits (32 hex digits) and must stay the same across restarts,
// so a re-registration updates the same mirror instead of making a new one.
// Pattern from the SEP2 Client Handbook, as used by ODE:
//   usage point:   first 22 hex of the LFDI + roleFlags + PEN
//   meter reading: first 22 hex of sha256(description) + roleFlags + PEN
function usagePointMrid(m: MirrorDefinition, lFDI: string, pen: string): string {
    return `${lFDI.slice(0, 22).toUpperCase()}${hex2(m.roleFlags)}${pen}`;
}

function readingMrid(m: MirrorDefinition, pen: string): string {
    const hash = createHash('sha256').update(m.readingDescription).digest('hex');
    return `${hash.slice(0, 22).toUpperCase()}${hex2(m.roleFlags)}${pen}`;
}

/**
 * A PEN as the 8 hex digits mRIDs end in. IANA lists PENs as decimal numbers;
 * IEEE 2030.5 puts the PEN in the mRID's lowest 32 bits, so it's converted.
 * Note ODE instead zero-pads whatever string it's configured with
 * (SEP2_PEN), so check which form the target network's server expects.
 */
export function penHex(pen: number): string {
    if (!Number.isInteger(pen) || pen < 0 || pen > 0xffffffff) throw new Error(`invalid PEN ${pen}`);
    return pen.toString(16).toUpperCase().padStart(8, '0');
}

function hex2(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, '0');
}
