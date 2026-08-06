import * as mongoose from 'mongoose';
import { WebhookLogSchema, WebhookStep, WebhookStepStatus } from '../../schemas/webhook-log.schema';
import { TransactionSchema, TransactionStatus } from '../../schemas/transactions.schema';
import { UserSchema } from '../../schemas/users.schema';
import { emptyResult, forceTimestamps, SeedResult } from '../lib/db';

const WebhookLog =
  mongoose.models.WebhookLogSeed ||
  mongoose.model('WebhookLogSeed', WebhookLogSchema, 'webhooklogs');
const Transaction =
  mongoose.models.TransactionSeedWh ||
  mongoose.model('TransactionSeedWh', TransactionSchema, 'transactions');
const User = mongoose.models.UserSeedWh || mongoose.model('UserSeedWh', UserSchema, 'users');

const OK = WebhookStepStatus.OK;
const WARN = WebhookStepStatus.WARN;
const ERR = WebhookStepStatus.ERROR;

const vnd = (n: number) => n.toLocaleString('vi-VN');

/**
 * getStepsByTransactionId() (webhook.service.ts) tra log qua
 * `{ 'steps.data.transaction_id': <transaction_id> }` — nên mọi log seed ra
 * BẮT BUỘC nhúng transaction_id của một transaction có thật, nếu không nút
 * "Điều tra nạp tiền" ở admin trả về rỗng.
 */
function buildSteps(tx: any, user: any, ip: string): WebhookStep[] {
  const txId = tx.transaction_id;
  const amount = tx.transfer_amount;
  const at = new Date(tx.transaction_date);

  const steps: WebhookStep[] = [
    {
      step: 1,
      title: 'Hệ thống nhận webhook từ ngân hàng',
      detail: `Webhook từ pays2 lúc ${at.toLocaleTimeString('vi-VN')} ${at.toLocaleDateString('vi-VN')}, 1 giao dịch`,
      status: OK,
      data: { ip, transaction_id: txId },
    },
    {
      step: 2,
      title: 'Giao dịch ngân hàng',
      detail: `+${vnd(amount)}đ từ ${tx.gateway}, mã: ${tx.transaction_number || '—'}`,
      status: OK,
      data: {
        gateway: tx.gateway,
        amount,
        account_number: tx.account_number,
        transaction_number: tx.transaction_number,
      },
    },
  ];

  if (tx.status === TransactionStatus.UNMATCHED || !user) {
    steps.push({
      step: 3,
      title: 'Nội dung CK khớp với user',
      detail: `Không tìm được user trong nội dung: "${tx.content}"`,
      status: ERR,
    });
    return steps;
  }

  steps.push({
    step: 3,
    title: 'Nội dung CK khớp với user',
    detail: `Khớp user ${String(user.email).split('@')[0]} (${user.email})`,
    status: OK,
    data: { user_id: user._id, email: user.email, code: tx.code },
  });

  if (tx.status === TransactionStatus.PENDING) {
    steps.push({
      step: 4,
      title: 'Lệnh nạp tiền',
      detail: `Trùng giao dịch #${txId} — bỏ qua`,
      status: WARN,
      data: { transaction_id: txId, amount },
    });
    return steps;
  }

  if (tx.status === TransactionStatus.REJECTED) {
    steps.push({
      step: 4,
      title: 'Từ chối nạp tiền',
      detail: tx.note || 'Số tiền dưới mức nạp tối thiểu',
      status: ERR,
      data: { transaction_id: txId, amount, user_id: user._id, email: user.email },
    });
    return steps;
  }

  if (tx.status === TransactionStatus.FAILED) {
    steps.push({
      step: 4,
      title: 'Lệnh nạp tiền',
      detail: tx.note || 'Xử lý thất bại',
      status: ERR,
      data: { transaction_id: txId, amount },
    });
    return steps;
  }

  steps.push({
    step: 4,
    title: 'Lệnh nạp tiền',
    detail: `Lệnh nạp #${txId}: ${vnd(amount)}đ (pays2)`,
    status: OK,
    data: { transaction_id: txId, amount },
  });
  steps.push({
    step: 5,
    title: 'Tiền đã cộng vào tài khoản',
    detail: `Cộng ${vnd(amount)}đ. Số dư: ${vnd(tx.balance_before)} → ${vnd(tx.balance_after)}đ`,
    status: OK,
    data: { balance_before: tx.balance_before, balance_after: tx.balance_after },
  });

  return steps;
}

export async function seedWebhookLogs(): Promise<SeedResult> {
  const result = emptyResult();

  // Ưu tiên các giao dịch vừa seed (dải 950xxx, phủ đủ trạng thái),
  // rồi thêm vài giao dịch thật gần nhất để log không chỉ toàn dữ liệu bất thường.
  const seeded = await Transaction.find({ transaction_id: { $gte: 950001, $lte: 959999 } })
    .sort({ transaction_id: 1 })
    .lean()
    .exec();
  const real = await Transaction.find({
    transaction_id: { $lt: 950001 },
    status: TransactionStatus.PROCESSED,
  })
    .sort({ transaction_date: -1 })
    .limit(4)
    .lean()
    .exec();

  const txs = [...seeded, ...real];
  if (txs.length === 0) return result;

  const userIds = txs.map((t: any) => t.user_id).filter(Boolean);
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id email')
    .lean()
    .exec();
  const userMap = new Map(users.map((u: any) => [String(u._id), u]));

  for (let i = 0; i < txs.length; i++) {
    const tx: any = txs[i];
    const payloadId = tx.transaction_id;
    const source = tx.gateway === 'BINANCE' ? 'binance_pay' : tx.source === 'manual' ? 'manual' : 'pays2';

    // Giao dịch admin nạp tay không đi qua webhook — bỏ qua
    if (source === 'manual') continue;

    if (
      await WebhookLog.findOne({ source, 'payload.transactions.id': payloadId })
        .select('_id')
        .lean()
        .exec()
    ) {
      result.skipped++;
      continue;
    }

    const user = tx.user_id ? userMap.get(String(tx.user_id)) : null;
    const ip = `103.9${i % 10}.14.${20 + (i % 60)}`;
    const at = new Date(tx.transaction_date);
    const steps = buildSteps(tx, user, ip);
    const failed = steps.some((s) => s.status === ERR);

    const created = await WebhookLog.create({
      source,
      headers: {
        'content-type': 'application/json',
        'user-agent': source === 'binance_pay' ? 'BinancePay-Webhook/1.0' : 'pays2-webhook/1.2',
        'x-forwarded-for': ip,
      },
      payload: {
        transactions: [
          {
            id: payloadId,
            gateway: tx.gateway,
            transactionDate: at.toISOString(),
            transactionNumber: tx.transaction_number,
            accountNumber: tx.account_number,
            content: tx.content,
            transferType: 'IN',
            transferAmount: tx.transfer_amount,
            checksum: tx.checksum,
          },
        ],
      },
      response: {
        success: true,
        message: failed
          ? `#${payloadId}: ${tx.status}`
          : `#${payloadId}: processed${user ? ` → ${user.email}` : ''}`,
      },
      steps,
      status_code: 200,
      ip,
    });
    await forceTimestamps(WebhookLog, { _id: created._id }, at);
    result.created++;
  }

  return result;
}
