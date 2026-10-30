import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { ChatMessageDocument } from '../schemas/chat-message.schema';
import { UserDocument } from '../schemas/users.schema';
import { NotificationGateway } from './notification.gateway';

describe('NotificationGateway Telegram channel routing', () => {
  const envKeys = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_DEPOSIT_BOT_TOKEN',
    'TELEGRAM_DEPOSIT_CHAT_ID',
    'TELEGRAM_ORDER_BOT_TOKEN',
    'TELEGRAM_ORDER_CHAT_ID',
  ];
  let savedEnv: Record<string, string | undefined>;
  let gateway: NotificationGateway;
  let fetchMock: jest.Mock;
  let userModel: { findById: jest.Mock };
  let select: jest.Mock;
  let lean: jest.Mock;

  beforeEach(() => {
    savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.TELEGRAM_BOT_TOKEN = 'test-legacy-bot';
    process.env.TELEGRAM_CHAT_ID = 'test-legacy-chat';

    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    jest.spyOn(global, 'fetch').mockImplementation(fetchMock);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    lean = jest.fn().mockResolvedValue({ name: 'Test User', email: 'user@example.test' });
    select = jest.fn().mockReturnValue({ lean });
    userModel = { findById: jest.fn().mockReturnValue({ select }) };
    gateway = new NotificationGateway(
      {} as Model<ChatMessageDocument>,
      userModel as unknown as Model<UserDocument>,
      { decode: jest.fn() } as unknown as JwtService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function expectTelegram(token: string, chatId: string, text: string) {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(String),
      },
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      chat_id: chatId,
      text: expect.stringContaining(text),
      parse_mode: 'HTML',
    });
    expect(userModel.findById).toHaveBeenCalledWith('test-user-id');
    expect(select).toHaveBeenCalledWith('email name');
    expect(lean).toHaveBeenCalledTimes(1);
  }

  it.each([
    ['dedicated config', 'test-deposit-bot', 'test-deposit-chat', 'test-deposit-bot', 'test-deposit-chat'],
    ['legacy fallback', undefined, undefined, 'test-legacy-bot', 'test-legacy-chat'],
    ['legacy bot fallback', undefined, 'test-deposit-chat', 'test-legacy-bot', 'test-deposit-chat'],
    ['legacy chat fallback', 'test-deposit-bot', undefined, 'test-deposit-bot', 'test-legacy-chat'],
    ['empty config fallback', '', '', 'test-legacy-bot', 'test-legacy-chat'],
  ])('sends pending deposits using %s', async (_, token, chatId, expectedToken, expectedChat) => {
    if (token !== undefined) process.env.TELEGRAM_DEPOSIT_BOT_TOKEN = token;
    if (chatId !== undefined) process.env.TELEGRAM_DEPOSIT_CHAT_ID = chatId;
    process.env.TELEGRAM_ORDER_BOT_TOKEN = 'test-order-bot';
    process.env.TELEGRAM_ORDER_CHAT_ID = 'test-order-chat';

    await gateway.sendTopupPending('test-user-id', { amount: 10000, source: 'test-bank' });

    expectTelegram(expectedToken!, expectedChat!, 'Giao dịch nạp chờ duyệt');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('Test User (user@example.test)');
    expect(body.text).toContain('test-bank');
  });

  it.each([
    ['order overrides', 'test-order-bot', 'test-order-chat', 'test-order-bot', 'test-order-chat'],
    ['default bot fallback', undefined, 'test-order-chat', 'test-legacy-bot', 'test-order-chat'],
    ['default chat fallback', 'test-order-bot', undefined, 'test-order-bot', 'test-legacy-chat'],
    ['default channel fallback', undefined, undefined, 'test-legacy-bot', 'test-legacy-chat'],
  ])('keeps active orders using %s', async (_, token, chatId, expectedToken, expectedChat) => {
    process.env.TELEGRAM_DEPOSIT_BOT_TOKEN = 'test-deposit-bot';
    process.env.TELEGRAM_DEPOSIT_CHAT_ID = 'test-deposit-chat';
    if (token !== undefined) process.env.TELEGRAM_ORDER_BOT_TOKEN = token;
    if (chatId !== undefined) process.env.TELEGRAM_ORDER_CHAT_ID = chatId;

    await gateway.sendOrderActive('test-user-id', {
      order_code: 'TEST-ORDER',
      service_name: 'Test service',
      quantity: 1,
      duration_days: 30,
      total_price: 10000,
    });

    expectTelegram(expectedToken!, expectedChat!, 'Đơn hàng giao thành công');
  });
});
