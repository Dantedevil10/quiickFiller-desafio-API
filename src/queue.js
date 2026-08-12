// src/queue.js
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
//const {IORedis} = ioRedis

// Conecta ao Redis (por padrão, tenta conectar no localhost:6379)
export const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null
});

// Cria a fila chamada 'pdf-extraction'
export const pdfQueue = new Queue('pdf-extraction', { connection });

//module.exports = { pdfQueue, connection };