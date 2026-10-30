import { BadRequestException } from '@nestjs/common';
import { IsArray, IsISO31661Alpha2, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ProviderBuyParams } from '../proxy-providers/proxy-provider.interface';

export const normalizeIso = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CountryOptionDto {
  @Transform(({ value }) => normalizeIso(value))
  @IsISO31661Alpha2()
  code: string;

  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  provider_value?: string;
}

export class CountryConfigDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CountryOptionDto)
  country_options?: CountryOptionDto[];
}

/** Validate the merged persisted state, including direct service-layer callers. */
export function validateCountryConfig(config: any, service = false) {
  const sources = service ? ['inherit', 'manual', 'api', 'none'] : ['manual', 'api', 'none'];
  if (config.country_source !== undefined && !sources.includes(config.country_source))
    throw new BadRequestException('Invalid country_source');
  const iso = (v: unknown): string => {
    const code = normalizeIso(v);
    if (typeof code !== 'string' || !new Set(ISO_CODES.split(' ')).has(code))
      throw new BadRequestException('Invalid ISO-2 country code');
    return code;
  };
  if (config.country_options !== undefined) {
    if (!Array.isArray(config.country_options)) throw new BadRequestException('Invalid country_options');
    config.country_options = config.country_options.map((o: any) => {
      if (!o || (o.name !== undefined && typeof o.name !== 'string') ||
        (o.provider_value !== undefined && (typeof o.provider_value !== 'string' || !o.provider_value.trim())))
        throw new BadRequestException('Invalid country option');
      return { code: iso(o.code), ...(o.name !== undefined ? { name: o.name } : {}),
        ...(o.provider_value !== undefined ? { provider_value: o.provider_value.trim() } : {}) };
    });
    if (new Set(config.country_options.map((o: any) => o.code)).size !== config.country_options.length)
      throw new BadRequestException('Duplicate country options');
  }
  if (config.country_source === 'manual' && !config.country_options?.length)
    throw new BadRequestException('Manual countries require country_options');
  if (service) {
    if (config.country_sales_mode !== undefined && !['all', 'allowlist'].includes(config.country_sales_mode))
      throw new BadRequestException('Invalid country_sales_mode');
    if (config.country_allowlist !== undefined) {
      if (!Array.isArray(config.country_allowlist)) throw new BadRequestException('Invalid country_allowlist');
      config.country_allowlist = [...new Set(config.country_allowlist.map(iso))];
    }
    if (config.country_sales_mode === 'allowlist' && !Array.isArray(config.country_allowlist))
      throw new BadRequestException('Allowlist mode requires country_allowlist (empty closes sales)');
    if (config.country_source === 'manual' && config.country_sales_mode === 'allowlist' &&
      config.country_allowlist.some((c: string) => !config.country_options.some((o: any) => o.code === c)))
      throw new BadRequestException('Allowlist country missing from manual options');
  }
  return config;
}

// ISO 3166-1 assigned alpha-2 codes; excludes informal aliases such as UK/XK.
const ISO_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

export interface CountrySnapshot {
  source: 'manual' | 'api' | 'none';
  code?: string;
  provider_value?: string;
  package_id: string;
}

/** Apply only snapshots from configured policy; absent snapshot preserves legacy templates. */
export function countryProviderParams(snapshot?: CountrySnapshot, partnerCode?: string): Partial<ProviderBuyParams> {
  return snapshot ? {
    country_policy_configured: true,
    country_code: snapshot.code,
    country_provider_value: snapshot.provider_value,
    // These connectors derive products from ISP/duration, not service.id_service.
    ...(snapshot.package_id?.trim() && !['homeproxy', 'proxyvn', 'twoproxy'].includes(partnerCode ?? '')
      ? { id_service: snapshot.package_id,
          // Only GPNIP needs country-package precedence over its body template.
          // Country selection alone does not declare an explicit product mapping.
          ...(partnerCode === 'gpnip' ? { product_id_configured: true } : {}) } : {}),
  } : {};
}

export function publicOrderConfig(config: any): Record<string, any> {
  const result = { ...config };
  delete result.product_mapping;
  if (result.country_policy) {
    result.country_policy = { source: result.country_policy.source, code: result.country_policy.code };
  }
  for (const key of Object.keys(result)) if (key.startsWith('gpnip_')) delete result[key];
  return result;
}
