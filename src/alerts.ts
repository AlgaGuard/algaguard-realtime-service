import pg from "pg";

export interface AlertRecord {
  alertId: string;
  deviceUuid: string;
  deviceId: string;
  organizationId: string;
  parameter: string;
  direction: "LOW" | "HIGH";
  value: number;
  minimum?: number | undefined;
  maximum?: number | undefined;
  profileId: string;
  profileVersion: number;
  occurredAt: string;
}

export interface AlertRepository {
  record(input: Omit<AlertRecord, "alertId" | "occurredAt">): Promise<void>;
  listByOrganization(
    organizationId: string,
    limit: number,
  ): Promise<AlertRecord[]>;
  listByDevice(deviceUuid: string, limit: number): Promise<AlertRecord[]>;
  close(): Promise<void>;
}

function toRecord(row: {
  alert_id: string;
  device_uuid: string;
  device_id: string;
  organization_id: string;
  parameter: string;
  direction: string;
  value: number;
  minimum: number | null;
  maximum: number | null;
  profile_id: string;
  profile_version: number;
  occurred_at: Date;
}): AlertRecord {
  return {
    alertId: row.alert_id,
    deviceUuid: row.device_uuid,
    deviceId: row.device_id,
    organizationId: row.organization_id,
    parameter: row.parameter,
    direction: row.direction as "LOW" | "HIGH",
    value: row.value,
    minimum: row.minimum ?? undefined,
    maximum: row.maximum ?? undefined,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export class PostgresAlertRepository implements AlertRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async record(input: Omit<AlertRecord, "alertId" | "occurredAt">) {
    await this.pool.query(
      `INSERT INTO alerts(device_uuid, device_id, organization_id, parameter, direction, value, minimum, maximum, profile_id, profile_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.deviceUuid,
        input.deviceId,
        input.organizationId,
        input.parameter,
        input.direction,
        input.value,
        input.minimum ?? null,
        input.maximum ?? null,
        input.profileId,
        input.profileVersion,
      ],
    );
  }

  async listByOrganization(organizationId: string, limit: number) {
    const result = await this.pool.query(
      `SELECT * FROM alerts WHERE organization_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map(toRecord);
  }

  async listByDevice(deviceUuid: string, limit: number) {
    const result = await this.pool.query(
      `SELECT * FROM alerts WHERE device_uuid = $1 ORDER BY occurred_at DESC LIMIT $2`,
      [deviceUuid, limit],
    );
    return result.rows.map(toRecord);
  }

  async close() {
    await this.pool.end();
  }
}

export class MemoryAlertRepository implements AlertRepository {
  private readonly rows: AlertRecord[] = [];

  async record(input: Omit<AlertRecord, "alertId" | "occurredAt">) {
    this.rows.push({
      ...input,
      alertId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    });
  }

  async listByOrganization(organizationId: string, limit: number) {
    return this.rows
      .filter((row) => row.organizationId === organizationId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  async listByDevice(deviceUuid: string, limit: number) {
    return this.rows
      .filter((row) => row.deviceUuid === deviceUuid)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  async close() {}
}
