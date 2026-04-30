import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export type RefreshStatus = 'ok' | 'partial' | 'failed';
export type SourceFormat =
  | 'txt'
  | 'json-array'
  | 'mullvad-relays'
  | 'airvpn-status'
  | 'ivpn-servers'
  | 'tor-csv'
  | 'avastel-csv';

export type SourceConfig = {
  url: string;
  format: SourceFormat;
  etag?: string | null;
  last_modified?: string | null;
  last_status?: 'ok' | 'failed' | 'not-modified' | null;
  last_count?: number | null;
  last_error?: string | null;
  last_fetched_at?: number | null;
};

export interface ProvidersTable {
  id: string;
  name: string;
  category: string;
  enabled: ColumnType<number, number | undefined, number>;
  sources: string;
  last_refresh_at: ColumnType<number | null, number | null | undefined, number | null>;
  last_refresh_status: ColumnType<RefreshStatus | null, RefreshStatus | null | undefined, RefreshStatus | null>;
  created_at: ColumnType<number, number | undefined, never>;
  updated_at: ColumnType<number, number | undefined, number>;
}

export interface IpRangesTable {
  id: Generated<number>;
  provider_id: string;
  start_ip: number;
  end_ip: number;
  cidr: string | null;
}

export interface IpRangesV6Table {
  id: Generated<number>;
  provider_id: string;
  start_ip: Buffer;
  end_ip: Buffer;
  cidr: string | null;
}

export interface Database {
  providers: ProvidersTable;
  ip_ranges: IpRangesTable;
  ip_ranges_v6: IpRangesV6Table;
}

export type ProviderRow = Selectable<ProvidersTable>;
export type ProviderInsert = Insertable<ProvidersTable>;
export type ProviderUpdate = Updateable<ProvidersTable>;
export type IpRangeRow = Selectable<IpRangesTable>;
