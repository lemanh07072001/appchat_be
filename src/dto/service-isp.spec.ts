import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateServiceDto } from './create-service.dto';

describe('Per-service ISP choices', () => {
  it('validates country lists using the same explicit-code restrictions', async () => {
    for (const country_choices of [[{ name: 'Mỹ', code: 'us' }, { name: 'Nhật', code: 'jp' }], []]) {
      const result = await validate(plainToInstance(CreateServiceDto, { country_choices }));
      expect(result.filter(error => error.property === 'country_choices')).toHaveLength(0);
    }
    const result = await validate(plainToInstance(CreateServiceDto, { country_choices: [{ name: 'Mỹ', code: 'us' }, { name: 'Khác', code: 'us' }] }));
    expect(result.some(error => error.property === 'country_choices')).toBe(true);
  });
  const errors = async (isp: unknown) => (await validate(plainToInstance(CreateServiceDto, { isp })))
    .filter(error => error.property === 'isp');
  it.each([[], [{ name: 'Nhà mạng mới', code: 'network_42' }],
    [{ name: 'Viettel', code: 'VIETTEL' }, { name: 'Ngẫu nhiên', code: 'ALL' }]].map(isp => ({ isp })))('accepts explicit choices %#', async ({ isp }) => {
    expect(await errors(isp)).toHaveLength(0);
  });
  it.each([[{ name: 'A', code: 'x' }, { name: 'B', code: 'x' }], [{ name: '', code: 'x' }],
    [{ name: 'A', code: '' }], [{ name: 'A', code: ' x ' }], [{ name: 'A', code: 'x\n' }],
    Array.from({ length: 201 }, (_, i) => ({ name: 'A', code: String(i) }))].map(isp => ({ isp })))('rejects unsafe lists %#', async ({ isp }) => {
    expect((await errors(isp)).length).toBeGreaterThan(0);
  });
});
