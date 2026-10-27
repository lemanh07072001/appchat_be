/**
 * Kiểm chứng SỐNG: cổng admin khai ở dịch vụ thắng cổng nhà cung cấp trả về.
 *
 * CHỈ ĐỌC ở phía nhà cung cấp và KHÔNG ghi proxy nào vào DB — chạy đúng hai
 * mảnh đang ghép với nhau (`resolveServicePorts` + `fetchOrderProxies`) rồi in
 * cổng ra, chứ không đi qua đường cập nhật proxy.
 *
 * Chạy:
 *   GPNIP_API_KEY=... npx ts-node scripts/verify-service-ports.ts <order_code>
 */
import { connect, connection, Schema, Types } from 'mongoose';
import { readFileSync } from 'fs';
import { GpnipProvider } from '../src/proxy-providers/impl/gpnip.provider';
import { resolveServicePorts } from '../src/orders/service-ports.util';

const ORDER_CODE = process.argv[2] ?? 'ORD-20261019-A74C8A512F';

async function main() {
  const env = readFileSync(`${__dirname}/../.env`, 'utf8');
  const uri = /MONGO_URI=(.+)/.exec(env)![1].trim();
  await connect(uri);

  const loose = new Schema({}, { strict: false });
  const Order = connection.model('Order', loose, 'orders');
  connection.model('Service', loose, 'services');
  const Partner = connection.model('Partner', loose, 'partners');

  const order: any = await Order.findOne({ order_code: ORDER_CODE }).exec();
  if (!order) throw new Error(`không thấy đơn ${ORDER_CODE}`);

  const partner: any = await Partner.findById(order.get('partner_id')).exec();
  const token = process.env.GPNIP_API_KEY ?? partner?.get('token_api');
  if (!token) throw new Error('thiếu GPNIP_API_KEY');

  const ports = await resolveServicePorts(order as any);
  console.log(`đơn           : ${ORDER_CODE}`);
  console.log(`cổng admin khai: ${ports ? JSON.stringify(ports) : '(chưa khai)'}`);

  const provider = new GpnipProvider();
  for (const protocol of ['http', 'socks5']) {
    const [p] = await provider.fetchOrderProxies(
      token,
      order.get('provider_order_id'),
      { metadata: order.get('provider_metadata'), protocol, ports },
    );
    console.log(
      `  ${protocol.padEnd(6)} -> ${p.host}:${p.port}` +
        `   metadata ${JSON.stringify(p.provider_metadata)}`,
    );
  }

  await connection.close();
}

main().catch((e) => {
  console.error('ERR', e?.message);
  process.exit(1);
});
