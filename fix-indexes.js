/**
 * Run: node fix-indexes.js
 * Fixes duplicate/problematic MongoDB indexes.
 */
const { MongoClient } = require('mongoose/node_modules/mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/proxydb';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();

  console.log('Connected to', MONGO_URI);

  // 1. Fix blogposts slug duplicate index
  try {
    const blogIndexes = await db.collection('blogposts').indexes();
    const slugIndexes = blogIndexes.filter(i => i.key?.slug && i.name !== '_id_');
    console.log(`\nblogposts slug indexes: ${slugIndexes.length}`);
    for (const idx of slugIndexes) {
      if (!idx.unique) {
        console.log(`  Dropping non-unique slug index: ${idx.name}`);
        await db.collection('blogposts').dropIndex(idx.name);
      } else {
        console.log(`  Keeping unique slug index: ${idx.name}`);
      }
    }
  } catch (e) {
    console.log('blogposts fix:', e.message);
  }

  // 2. Fix users api_token index
  try {
    const userIndexes = await db.collection('users').indexes();
    const tokenIndexes = userIndexes.filter(i => i.key?.api_token);
    console.log(`\nusers api_token indexes: ${tokenIndexes.length}`);
    for (const idx of tokenIndexes) {
      console.log(`  Dropping old api_token index: ${idx.name}`, JSON.stringify(idx));
      await db.collection('users').dropIndex(idx.name);
    }
    console.log('  Old indexes dropped. Restart backend to create new partial index.');
  } catch (e) {
    console.log('users fix:', e.message);
  }

  await client.close();
  console.log('\nDone. Restart backend now.');
}

main().catch(console.error);
