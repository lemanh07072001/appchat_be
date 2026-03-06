/**
 * Kiểm tra sub trong JWT có khớp với _id admin không
 * Run: node scripts/check-jwt-sub.js <access_token>
 */
const token = process.argv[2];
if (!token) { console.error('Usage: node scripts/check-jwt-sub.js <access_token>'); process.exit(1); }

const [, payload] = token.split('.');
const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
console.log('JWT payload:', JSON.stringify(decoded, null, 2));
console.log('\nsub:', decoded.sub);
console.log('admin _id:', '69a19345ab66168b4856796e');
console.log('Match:', decoded.sub === '69a19345ab66168b4856796e');
