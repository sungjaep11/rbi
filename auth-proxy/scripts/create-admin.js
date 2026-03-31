'use strict';

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'users.json');

const [,, username, password, role = 'admin'] = process.argv;

if (!username || !password) {
  console.error('Usage: node scripts/create-admin.js <username> <password> [role]');
  process.exit(1);
}

if (!['admin', 'user'].includes(role)) {
  console.error('role must be "admin" or "user"');
  process.exit(1);
}

const users = fs.existsSync(DB_PATH)
  ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
  : [];

if (users.find(u => u.username === username)) {
  console.error(`User "${username}" already exists.`);
  process.exit(1);
}

users.push({
  username,
  passwordHash: bcrypt.hashSync(password, 12),
  role,
  createdAt: new Date().toISOString(),
});

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
console.log(`Created ${role} user: ${username}`);
