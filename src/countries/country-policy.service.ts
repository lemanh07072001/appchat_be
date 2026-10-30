import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash } from 'crypto';
import { Partner } from '../schemas/partners.schema';
import { Country } from '../schemas/countries.schema';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';
import { CountryOptionDto, CountrySnapshot, validateCountryConfig } from './country-policy';
import { resolveProduct } from '../services/product-mapping';

export interface EffectiveCountries {
  source: 'manual' | 'api' | 'none' | 'legacy';
  status: 'ready' | 'unavailable' | 'error';
  countries: { code: string; name?: string }[];
  requires_selection: boolean;
  updated_at?: string;
  message?: string;
}

@Injectable()
export class CountryPolicyService {
  private readonly cache = new Map<string, { expires: number; options: CountryOptionDto[]; updated_at: string }>();
  private readonly inflight = new Map<string, Promise<{ expires: number; options: CountryOptionDto[]; updated_at: string }>>();
  constructor(
    @InjectModel(Partner.name) private readonly partners: Model<Partner>,
    @InjectModel(Country.name) private readonly countries: Model<Country>,
    private readonly factory: ProxyProviderFactory,
  ) {}

  packageId(service: any, duration?: number, partnerCode?: string, isp?: string): string {
    return resolveProduct(service, isp, duration, partnerCode).product_id;
  }

  private async resolve(service: any, duration?: number, suppliedPartner?: any, isp?: string) {
    const partner = suppliedPartner ?? (service.partner ? await this.partners.findById(service.partner).exec() : null);
    const source = service.country_source === undefined ? 'legacy' :
      service.country_source === 'inherit' ? partner?.country_source ?? 'legacy' : service.country_source;
    const package_id = this.packageId(service, duration, partner?.code, isp);
    let options: CountryOptionDto[] = [];
    let updated_at: string | undefined;
    let status: EffectiveCountries['status'] = 'ready';
    let message: string | undefined;
    try {
      if ((source === 'manual' || source === 'api') &&
        this.factory.getProvider(partner?.code).capabilities?.countrySelection !== true) {
        message = 'Country selection is not supported by this provider adapter';
        throw new Error();
      }
      if (source === 'legacy') {
        const country = service.country ? await this.countries.findById(service.country).exec() : null;
        if (country?.code) options = [{ code: country.code.toUpperCase(), name: country.name }];
      } else if (source === 'manual') {
        options = (service.country_source === 'inherit' ? partner?.country_options : service.country_options) ?? [];
        validateCountryConfig({ country_source: 'manual', country_options: options });
      } else if (source === 'api') {
        if (!partner?.token_api?.trim() || !package_id) throw new Error();
        const provider = this.factory.getProvider(partner.code);
        if (!provider.listCountriesForPackage) throw new Error();
        const key = createHash('sha256').update(JSON.stringify([partner.code, partner.token_api, package_id])).digest('hex');
        let cached = this.cache.get(key);
        if (!cached || cached.expires <= Date.now()) {
          let pending = this.inflight.get(key);
          if (!pending) {
            // Defer invocation so even a synchronous adapter throw is shared safely.
            pending = Promise.resolve().then(async () => {
              const result = await provider.listCountriesForPackage!(partner.token_api, package_id);
              if (!Array.isArray(result.iso_codes)) throw new Error();
              const config = validateCountryConfig({ country_options: [...new Set(result.iso_codes)].map(code => ({ code })) });
              const entry = { options: config.country_options, updated_at: new Date().toISOString(), expires: Date.now() + 300_000 };
              if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
              this.cache.set(key, entry);
              return entry;
            }).finally(() => { this.inflight.delete(key); });
            this.inflight.set(key, pending);
          }
          cached = await pending;
        }
        options = cached.options;
        updated_at = cached.updated_at;
      } else if (source !== 'none') throw new Error();
      if (source !== 'legacy' && service.country_sales_mode === 'allowlist')
        options = options.filter(o => (service.country_allowlist ?? []).includes(o.code));
      if (source !== 'none' && source !== 'legacy' && !options.length) status = 'unavailable';
    } catch {
      status = 'error';
      options = [];
      message ??= 'Country configuration or provider coverage unavailable';
    }
    const effective: EffectiveCountries = { source, status, countries: options.map(o => ({ code: o.code, name: o.name ?? o.code })),
      requires_selection: source !== 'legacy' && source !== 'none' && options.length > 1,
      ...(updated_at ? { updated_at } : {}), ...(message ? { message } : {}) };
    return { effective, options, package_id, partner };
  }

  async effective(service: any, duration?: number, isp?: string): Promise<EffectiveCountries> {
    return (await this.resolve(service, duration, undefined, isp)).effective;
  }

  async select(service: any, input?: string, duration?: number, partner?: any, isp?: string): Promise<CountrySnapshot | undefined> {
    if (service.country_source === undefined) return undefined;
    const resolved = await this.resolve(service, duration, partner, isp);
    const { effective, options, package_id } = resolved;
    partner = resolved.partner;
    if (effective.source === 'legacy') return undefined;
    if (effective.status !== 'ready') throw new BadRequestException(effective.message ?? 'Countries unavailable; purchase has not been charged');
    if (effective.source === 'none') {
      if (input?.trim()) throw new BadRequestException('This service does not accept a country selection');
      if (partner?.code === 'proxyseller') throw new BadRequestException('ProxySeller requires a country selection');
      return { source: 'none', package_id };
    }
    let code = input?.trim().toUpperCase();
    if (input && !options.some(o => o.code === code)) {
      const found = Types.ObjectId.isValid(input) ? await this.countries.findById(input).exec() :
        await this.countries.findOne({ name: { $regex: `^${input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }).exec();
      code = found?.code?.toUpperCase() ?? options.find(o => o.name?.toLowerCase() === input.trim().toLowerCase())?.code;
    }
    const selected = !input?.trim() && options.length === 1 ? options[0] : options.find(o => o.code === code);
    if (!selected) throw new BadRequestException('Select an available country');
    if (partner?.code === 'proxyseller' && !selected.provider_value)
      throw new BadRequestException('ProxySeller requires a manual country provider_value (countryId)');
    return { source: effective.source, code: selected.code, provider_value: selected.provider_value ?? selected.code, package_id };
  }
}
