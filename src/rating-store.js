const path = require('path');
const Database = require('better-sqlite3');

class RatingStore {
    constructor(dataDir, options = {}) {
        this.dataDir = dataDir;
        this.dbPath = path.join(dataDir, 'ratings.sqlite');
        this.db = null;
        this.alpha = typeof options.alpha === 'number' ? options.alpha : 0.2;
        this.targetMs = typeof options.targetMs === 'number' ? options.targetMs : 30 * 60 * 1000;
        this.minTasks = typeof options.minTasks === 'number' ? options.minTasks : 10;
        this.threshold = typeof options.threshold === 'number' ? options.threshold : 10;
    }

    init() {
        this.db = new Database(this.dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS node_ratings (
                node_id TEXT PRIMARY KEY,
                ewma REAL DEFAULT 0,
                completed INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,
                likes INTEGER DEFAULT 0,
                score INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS task_likes (
                task_id TEXT PRIMARY KEY,
                liked_by_node TEXT,
                liked_at INTEGER
            );
        `);
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    getNode(nodeId) {
        return this.db.prepare('SELECT * FROM node_ratings WHERE node_id = ?').get(nodeId) || null;
    }

    ensureNode(nodeId) {
        const existing = this.getNode(nodeId);
        if (existing) return existing;
        this.db.prepare('INSERT INTO node_ratings (node_id, updated_at) VALUES (?, ?)').run(nodeId, Date.now());
        return this.getNode(nodeId);
    }

    mapDurationToScore(durationMs) {
        if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
        const raw = (this.targetMs / durationMs) * 10000;
        return Math.max(0, Math.min(10000, Math.round(raw)));
    }

    computeScore(row) {
        const base = Number(row.ewma || 0);
        const completed = Number(row.completed || 0);
        const failed = Number(row.failed || 0);
        const likes = Number(row.likes || 0);
        const score = Math.round(base + completed * 2 + likes - failed * 10);
        return Math.max(0, score);
    }

    recordCompletion(nodeId, durationMs) {
        const row = this.ensureNode(nodeId);
        const speedScore = this.mapDurationToScore(durationMs);
        const ewma = row.ewma ? (this.alpha * speedScore + (1 - this.alpha) * row.ewma) : speedScore;
        const completed = Number(row.completed || 0) + 1;
        const updated = {
            ewma,
            completed
        };
        const score = this.computeScore({ ...row, ...updated });
        this.db.prepare(`
            UPDATE node_ratings
            SET ewma = ?, completed = ?, score = ?, updated_at = ?
            WHERE node_id = ?
        `).run(ewma, completed, score, Date.now(), nodeId);
        return this.getNode(nodeId);
    }

    recordFailure(nodeId) {
        const row = this.ensureNode(nodeId);
        const failed = Number(row.failed || 0) + 1;
        const score = this.computeScore({ ...row, failed });
        this.db.prepare(`
            UPDATE node_ratings
            SET failed = ?, score = ?, updated_at = ?
            WHERE node_id = ?
        `).run(failed, score, Date.now(), nodeId);
        return this.getNode(nodeId);
    }

    addLike(taskId, nodeId, likedByNode = null) {
        const existing = this.db.prepare('SELECT 1 FROM task_likes WHERE task_id = ?').get(taskId);
        if (existing) return { ok: false, reason: 'Task already liked' };
        this.db.prepare('INSERT INTO task_likes (task_id, liked_by_node, liked_at) VALUES (?, ?, ?)').run(taskId, likedByNode, Date.now());
        const row = this.ensureNode(nodeId);
        const likes = Number(row.likes || 0) + 1;
        const score = this.computeScore({ ...row, likes });
        this.db.prepare(`
            UPDATE node_ratings
            SET likes = ?, score = ?, updated_at = ?
            WHERE node_id = ?
        `).run(likes, score, Date.now(), nodeId);
        return { ok: true };
    }

    isDisqualified(nodeId) {
        const row = this.getNode(nodeId);
        if (!row) return false;
        if (Number(row.completed || 0) < this.minTasks) return false;
        return Number(row.score || 0) < this.threshold;
    }

    hasLike(taskId) {
        return Boolean(this.db.prepare('SELECT 1 FROM task_likes WHERE task_id = ?').get(taskId));
    }

    getRules() {
        return {
            alpha: this.alpha,
            targetMs: this.targetMs,
            minTasks: this.minTasks,
            threshold: this.threshold,
            pointsPerTask: 2,
            penaltyPerFail: 10,
            likePoints: 1,
            maxSpeedScore: 10000
        };
    }
}

module.exports = RatingStore;
