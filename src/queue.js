// src/queue.js
import { Queue } from 'bullmq';
import Redis from 'ioredis';

// Cria a conexão com o Redis e exporta para o resto do app usar
export const redis = new Redis({
    maxRetriesPerRequest: null
});

export const pdfQueue = new Queue('pdf-extraction', { 
    connection: redis 
});