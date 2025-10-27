import { promises as fsPromises } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

import storage from 'node-persist';
import express from 'express';
import lodash from 'lodash';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import {
    KEY_PREFIX,
    toKey,
    requireAdminMiddleware,
    getUserAvatar,
    getAllUserHandles,
    getPasswordSalt,
    getPasswordHash,
    getUserDirectories,
    ensurePublicDirectoriesExist,
} from '../users.js';
import { DEFAULT_USER } from '../constants.js';
import systemMonitor from '../system-monitor.js';


export const router = express.Router();

/**
 * @typedef {import('../users.js').UserViewModel & {
 *   loadStats?: {
 *     loadPercentage?: number;
 *     totalMessages?: number;
 *     lastActivityFormatted?: string;
 *   } | null,
 *   storageSize?: number
 * }} AdminUserViewModel
 */

/**
 * 递归计算目录大小（字节）
 * @param {string} dirPath - 目录路径
 * @returns {Promise<number>} - 目录大小（字节）
 */
async function calculateDirectorySize(dirPath) {
    let totalSize = 0;

    try {
        if (!fs.existsSync(dirPath)) {
            return 0;
        }

        const items = await fsPromises.readdir(dirPath);

        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stats = await fsPromises.stat(itemPath);

            if (stats.isDirectory()) {
                totalSize += await calculateDirectorySize(itemPath);
            } else {
                totalSize += stats.size;
            }
        }
    } catch (error) {
        console.error('Error calculating directory size:', error);
    }

    return totalSize;
}

router.post('/get', requireAdminMiddleware, async (_request, response) => {
    try {
        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<AdminUserViewModel>[]} */
        const viewModelPromises = users
        .map(user => new Promise(async (resolve) => {
            const avatar = await getUserAvatar(user.handle);
            // 获取用户负载统计（如果可用）
            const loadStats = systemMonitor.getUserLoadStats(user.handle);

            // 计算用户目录大小
            const directories = getUserDirectories(user.handle);
            const storageSize = await calculateDirectorySize(directories.root);

            resolve({
                handle: user.handle,
                name: user.name,
                avatar: avatar,
                admin: user.admin,
                enabled: user.enabled,
                created: user.created,
                password: !!user.password,
                storageSize: storageSize,
                loadStats: loadStats ? {
                    loadPercentage: loadStats.loadPercentage,
                    totalMessages: loadStats.totalMessages,
                    lastActivityFormatted: loadStats.lastActivityFormatted
                } : null
            });
        }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/disable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Disable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Disable user failed: Cannot disable yourself');
            return response.status(400).json({ error: 'Cannot disable yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Disable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = false;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User disable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/enable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Enable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Enable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = true;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User enable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/promote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Promote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Promote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = true;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User promote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/demote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Demote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Demote user failed: Cannot demote yourself');
            return response.status(400).json({ error: 'Cannot demote yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Demote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = false;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User demote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/create', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle || !request.body.name) {
            console.warn('Create user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const handles = await getAllUserHandles();
        const handle = lodash.kebabCase(String(request.body.handle).toLowerCase().trim());

        if (!handle) {
            console.warn('Create user failed: Invalid handle');
            return response.status(400).json({ error: 'Invalid handle' });
        }

        if (handles.some(x => x === handle)) {
            console.warn('Create user failed: User with that handle already exists');
            return response.status(409).json({ error: 'User already exists' });
        }

        const salt = getPasswordSalt();
        const password = request.body.password ? getPasswordHash(request.body.password, salt) : '';

        const newUser = {
            handle: handle,
            name: request.body.name || 'Anonymous',
            created: Date.now(),
            password: password,
            salt: salt,
            admin: !!request.body.admin,
            enabled: true,
        };

        await storage.setItem(toKey(handle), newUser);

        // Create user directories
        console.info('Creating data directories for', newUser.handle);
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(newUser.handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        return response.json({ handle: newUser.handle });
    } catch (error) {
        console.error('User create failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Delete user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Delete user failed: Cannot delete yourself');
            return response.status(400).json({ error: 'Cannot delete yourself' });
        }

        if (request.body.handle === DEFAULT_USER.handle) {
            console.warn('Delete user failed: Cannot delete default user');
            return response.status(400).json({ error: 'Sorry, but the default user cannot be deleted. It is required as a fallback.' });
        }

        await storage.removeItem(toKey(request.body.handle));

        if (request.body.purge) {
            const directories = getUserDirectories(request.body.handle);
            console.info('Deleting data directories for', request.body.handle);
            await fsPromises.rm(directories.root, { recursive: true, force: true });
        }

        return response.sendStatus(204);
    } catch (error) {
        console.error('User delete failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/slugify', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.text) {
            console.warn('Slugify failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const text = lodash.kebabCase(String(request.body.text).toLowerCase().trim());

        return response.send(text);
    } catch (error) {
        console.error('Slugify failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * 清理单个用户的备份文件
 */
router.post('/clear-backups', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Clear backups failed: Missing required fields');
            return response.status(400).json({ error: '缺少必需字段' });
        }

        const handle = request.body.handle;
        const directories = getUserDirectories(handle);

        let deletedSize = 0;
        let deletedFiles = 0;

        // 只清理备份目录
        if (fs.existsSync(directories.backups)) {
            const backupsSize = await calculateDirectorySize(directories.backups);
            deletedSize += backupsSize;
            const files = await fsPromises.readdir(directories.backups);
            deletedFiles += files.length;
            await fsPromises.rm(directories.backups, { recursive: true, force: true });
            // 重新创建空目录
            await fsPromises.mkdir(directories.backups, { recursive: true });
        }

        console.info(`Cleared backups for user ${handle}: ${deletedFiles} files, ${deletedSize} bytes`);
        return response.json({
            success: true,
            deletedSize: deletedSize,
            deletedFiles: deletedFiles,
            message: `已清理 ${deletedFiles} 个备份文件，释放 ${(deletedSize / 1024 / 1024).toFixed(2)} MB 空间`
        });
    } catch (error) {
        console.error('Clear backups failed:', error);
        return response.status(500).json({ error: '清理备份文件失败: ' + error.message });
    }
});

/**
 * 一键清理所有用户的备份文件
 */
router.post('/clear-all-backups', requireAdminMiddleware, async (request, response) => {
    try {
        const userHandles = await getAllUserHandles();
        let totalDeletedSize = 0;
        let totalDeletedFiles = 0;
        const results = [];

        for (const handle of userHandles) {
            try {
                const directories = getUserDirectories(handle);
                let userDeletedSize = 0;
                let userDeletedFiles = 0;

                // 只清理备份目录
                if (fs.existsSync(directories.backups)) {
                    const backupsSize = await calculateDirectorySize(directories.backups);
                    userDeletedSize += backupsSize;
                    const files = await fsPromises.readdir(directories.backups);
                    userDeletedFiles += files.length;
                    await fsPromises.rm(directories.backups, { recursive: true, force: true });
                    await fsPromises.mkdir(directories.backups, { recursive: true });
                }

                totalDeletedSize += userDeletedSize;
                totalDeletedFiles += userDeletedFiles;
                results.push({
                    handle: handle,
                    deletedSize: userDeletedSize,
                    deletedFiles: userDeletedFiles
                });

                console.info(`Cleared backups for user ${handle}: ${userDeletedFiles} files, ${userDeletedSize} bytes`);
            } catch (error) {
                console.error(`Error clearing backups for user ${handle}:`, error);
                results.push({
                    handle: handle,
                    error: error.message
                });
            }
        }

        console.info(`Cleared all backups: ${totalDeletedFiles} files, ${totalDeletedSize} bytes`);
        return response.json({
            success: true,
            totalDeletedSize: totalDeletedSize,
            totalDeletedFiles: totalDeletedFiles,
            results: results,
            message: `已清理 ${userHandles.length} 个用户的备份文件，共 ${totalDeletedFiles} 个文件，释放 ${(totalDeletedSize / 1024 / 1024).toFixed(2)} MB 空间`
        });
    } catch (error) {
        console.error('Clear all backups failed:', error);
        return response.status(500).json({ error: '清理所有备份文件失败: ' + error.message });
    }
});
