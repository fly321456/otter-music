package com.otterhub.music;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.content.res.Configuration;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "LocalMusicPlugin", permissions = {
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "manageStorage", strings = { Manifest.permission.MANAGE_EXTERNAL_STORAGE })
})
public class LocalMusicPlugin extends Plugin {

    private static final String PERMISSION_ALIAS = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "storage";
    private static final String[] AUDIO_EXTENSIONS = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".wma", ".ape", ".opus", ".m4b"};
    private static final int MAX_DEPTH = 20;
    private static final int MAX_FILES = 10000;
    private static final long MIN_DURATION = 30000;
    private static final String DEFAULT_DOWNLOAD_DIR = "Download/OtterMusic";

    private final ExecutorService executor = Executors.newFixedThreadPool(1);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean isScanning = false;

    @PluginMethod
    public void scanLocalMusic(PluginCall call) {
        if (isScanning) {
            resolveError(call, "扫描正在进行中");
            return;
        }
        if (!hasRequiredPermission()) {
            requestPermissionForAlias(PERMISSION_ALIAS, call, "handlePermissionResult");
            return;
        }
        String downloadDir = call.getString("downloadDirectory");
        scanMusicFiles(call, downloadDir);
    }

    @PluginMethod
    public void scanAllStorage(PluginCall call) {
        if (isScanning) {
            resolveError(call, "扫描正在进行中");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
            JSObject result = new JSObject().put("success", false).put("error", "需要授予\"允许管理所有文件\"权限").put("needManageStorage", true);
            call.resolve(result);
            return;
        } else if (!hasRequiredPermission()) {
            requestPermissionForAlias(PERMISSION_ALIAS, call, "handleAllStoragePermissionResult");
            return;
        }
        String downloadDir = call.getString("downloadDirectory");
        executeAllStorageScan(call, downloadDir);
    }

    @PluginMethod
    public void openManageStorageSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(intent);
            } catch (Exception e) {
                getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void hasAllStoragePermission(PluginCall call) {
        boolean hasPerm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? Environment.isExternalStorageManager() : hasRequiredPermission();
        call.resolve(new JSObject().put("hasPermission", hasPerm));
    }

    @PluginMethod
    public void pickDownloadDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "handlePickDirectoryResult");
    }

    @ActivityCallback
    private void handlePickDirectoryResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject().put("success", false).put("error", "cancelled"));
            return;
        }

        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.resolve(new JSObject().put("success", false).put("error", "No directory selected"));
            return;
        }

        String relativePath = extractPathFromTreeUri(treeUri);
        call.resolve(new JSObject()
            .put("success", true)
            .put("path", relativePath != null ? relativePath : "")
            .put("uri", treeUri.toString()));
    }

    @PermissionCallback
    private void handlePermissionResult(PluginCall call) {
        if (hasRequiredPermission()) {
            String downloadDir = call.getString("downloadDirectory");
            scanMusicFiles(call, downloadDir);
        } else {
            resolveError(call, "Permission denied");
        }
    }

    @PermissionCallback
    private void handleAllStoragePermissionResult(PluginCall call) {
        if (hasRequiredPermission()) {
            String downloadDir = call.getString("downloadDirectory");
            executeAllStorageScan(call, downloadDir);
        } else {
            resolveError(call, "Permission denied");
        }
    }

    private boolean hasRequiredPermission() {
        return getPermissionState(PERMISSION_ALIAS) == PermissionState.GRANTED;
    }

    @PluginMethod
    public void getSystemDarkMode(PluginCall call) {
        int nightModeFlags = getContext().getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean isDarkMode = nightModeFlags == Configuration.UI_MODE_NIGHT_YES;
        call.resolve(new JSObject().put("isDarkMode", isDarkMode));
    }

    private void scanMusicFiles(PluginCall call, String downloadDirectory) {
        isScanning = true;
        executor.execute(() -> {
            try {
                JSObject result = performMediaStoreScan(downloadDirectory);
                mainHandler.post(() -> call.resolve(result));
            } finally {
                isScanning = false;
            }
        });
    }

    private JSObject performMediaStoreScan(String downloadDirectory) {
        JSArray filesArray = new JSArray();
        Set<String> foundContentUris = new HashSet<>();
        Set<String> foundFilePaths = new HashSet<>();
        ContentResolver resolver = getContext().getContentResolver();
        Uri musicUri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;

        String[] projection;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            projection = new String[]{
                    MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
                    MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.SIZE,
                    MediaStore.Audio.Media.DATE_MODIFIED, MediaStore.Audio.Media.RELATIVE_PATH, MediaStore.Audio.Media.DISPLAY_NAME
            };
        } else {
            projection = new String[]{
                    MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
                    MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.SIZE,
                    MediaStore.Audio.Media.DATE_MODIFIED, MediaStore.Audio.Media.DATA
            };
        }

        String selection = buildMediaStoreMusicSelection();

        try (Cursor cursor = resolver.query(musicUri, projection, selection, null, MediaStore.Audio.Media.DATE_MODIFIED + " DESC")) {
            if (cursor != null && cursor.moveToFirst()) {
                int idCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                int titleCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                int artistCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                int albumCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                int durationCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                int sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
                int modifiedCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED);

                int pathCol = -1;
                int relPathCol = -1;
                int displayNameCol = -1;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    relPathCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.RELATIVE_PATH);
                    displayNameCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
                } else {
                    pathCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA);
                }

                do {
                    long id = cursor.getLong(idCol);
                    Uri contentUri = ContentUris.withAppendedId(musicUri, id);
                    String contentUriStr = contentUri.toString();

                    String filePath = null;
                    String relativePath = null;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        relativePath = cursor.getString(relPathCol);
                        String displayName = cursor.getString(displayNameCol);
                        if (relativePath != null && displayName != null) {
                            filePath = Environment.getExternalStorageDirectory() + "/" + relativePath + displayName;
                        }
                    } else {
                        filePath = cursor.getString(pathCol);
                    }

                    if (downloadDirectory != null && !downloadDirectory.isEmpty()) {
                        String normalizedDownloadDir = downloadDirectory.replace("\\", "/");
                        if (!normalizedDownloadDir.endsWith("/")) {
                            normalizedDownloadDir = normalizedDownloadDir + "/";
                        }
                        boolean matchesDir = false;
                        if (relativePath != null) {
                            matchesDir = relativePath.startsWith(normalizedDownloadDir) || normalizedDownloadDir.startsWith(relativePath);
                        } else if (filePath != null) {
                            String normalizedFilePath = filePath.replace("\\", "/");
                            String downloadPath = Environment.getExternalStorageDirectory().getPath().replace("\\", "/") + "/" + normalizedDownloadDir;
                            matchesDir = normalizedFilePath.startsWith(downloadPath);
                        }
                        if (!matchesDir) {
                            continue;
                        }
                    }

                    long duration = cursor.getLong(durationCol);
                    if (duration > 0 && duration < MIN_DURATION) {
                        continue;
                    }

                    if (foundContentUris.contains(contentUriStr)) {
                        continue;
                    }
                    foundContentUris.add(contentUriStr);
                    if (filePath != null) {
                        foundFilePaths.add(new File(filePath).getAbsolutePath());
                    }

                    String title = cursor.getString(titleCol);
                    String artist = cursor.getString(artistCol);

                    if (filePath != null) {
                        String[] parsed = parseFileName(new File(filePath).getName());
                        if (isValid(parsed[0])) {
                            title = parsed[0];
                            if (isValid(parsed[1])) {
                                artist = parsed[1];
                            }
                        }
                    }

                    filesArray.put(new JSObject()
                            .put("id", "mediastore:" + id)
                            .put("name", formatUnknown(title))
                            .put("artist", formatUnknown(artist))
                            .put("album", formatUnknown(cursor.getString(albumCol)))
                            .put("duration", duration)
                            .put("localPath", contentUriStr)
                            .put("fileSize", cursor.getLong(sizeCol))
                            .put("modifiedTime", cursor.getLong(modifiedCol) * 1000));
                } while (cursor.moveToNext());
            }
        } catch (Exception e) {
            return new JSObject().put("success", false).put("error", "Failed: " + e.getMessage()).put("files", new JSArray());
        }

        String scanDir = (downloadDirectory != null && !downloadDirectory.isEmpty())
                ? downloadDirectory : DEFAULT_DOWNLOAD_DIR;
        File downloadDirFile = new File(Environment.getExternalStorageDirectory(), scanDir);
        if (downloadDirFile.exists() && downloadDirFile.canRead()) {
            List<JSObject> directFiles = new ArrayList<>();
            scanDirectory(downloadDirFile, directFiles, 0, foundFilePaths);
            for (JSObject file : directFiles) {
                filesArray.put(file);
            }
        }

        return new JSObject().put("success", true).put("files", filesArray);
    }

    private String buildMediaStoreMusicSelection() {
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            selection += " AND " + MediaStore.Audio.Media.IS_RECORDING + " = 0"
                    + " AND " + MediaStore.Audio.Media.IS_PODCAST + " = 0"
                    + " AND " + MediaStore.Audio.Media.IS_RINGTONE + " = 0"
                    + " AND " + MediaStore.Audio.Media.IS_ALARM + " = 0"
                    + " AND " + MediaStore.Audio.Media.IS_NOTIFICATION + " = 0";
        }
        return selection;
    }

    private void executeAllStorageScan(PluginCall call, String downloadDirectory) {
        isScanning = true;
        executor.execute(() -> {
            try {
                List<JSObject> filesList = new ArrayList<>();
                File extStorage = Environment.getExternalStorageDirectory();

                if (downloadDirectory != null && !downloadDirectory.isEmpty()) {
                    File downloadDir = new File(extStorage, downloadDirectory);
                    if (downloadDir.exists() && downloadDir.canRead()) {
                        scanDirectory(downloadDir, filesList, 0, new HashSet<>());
                    }
                }

                if (filesList.isEmpty() && extStorage != null && extStorage.canRead()) {
                    scanDirectory(extStorage, filesList, 0, new HashSet<>());
                }

                JSArray filesArray = new JSArray();
                for (JSObject file : filesList) filesArray.put(file);

                mainHandler.post(() -> resolveSuccess(call, "files", filesArray));
            } finally {
                isScanning = false;
            }
        });
    }

    private void scanDirectory(File directory, List<JSObject> filesList, int depth, Set<String> excludePaths) {
        if (depth > MAX_DEPTH || directory == null || !directory.canRead() || filesList.size() >= MAX_FILES) return;

        File[] children = directory.listFiles();
        if (children == null) {
            android.util.Log.d("LocalMusicPlugin", "Cannot read directory (null): " + directory.getAbsolutePath());
            return;
        }

        for (File file : children) {
            if (filesList.size() >= MAX_FILES) return;
            if (file.isDirectory() && !file.getName().startsWith(".") && !isSystemDirectory(file)) {
                scanDirectory(file, filesList, depth + 1, excludePaths);
            } else if (isAudioFile(file.getName())) {
                if (excludePaths.contains(file.getAbsolutePath())) {
                    continue;
                }
                JSObject audioFile = extractAudioMetadata(file);
                if (audioFile != null) {
                    filesList.add(audioFile);
                }
            }
        }
    }

    private JSObject extractAudioMetadata(File file) {
        if (!file.exists() || !file.canRead()) {
            android.util.Log.w("LocalMusicPlugin", "File cannot be read: " + file.getAbsolutePath());
            return null;
        }

        long fileLength = file.length();
        if (fileLength < 100 * 1024) {
            return null;
        }

        String absolutePath = file.getAbsolutePath();
        String fileId = "file:" + absolutePath;

        String[] parsed = parseFileName(file.getName());
        JSObject audioFile = new JSObject()
                .put("id", fileId)
                .put("localPath", absolutePath)
                .put("fileSize", fileLength)
                .put("modifiedTime", file.lastModified())
                .put("name", parsed[0])
                .put("artist", parsed[1])
                .put("album", null)
                .put("duration", 0);

        try (MediaMetadataRetriever retriever = new MediaMetadataRetriever()) {
            setRetrieverDataSource(retriever, absolutePath);
            String mTitle = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE);
            String mArtist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST);
            String mAlbum = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM);
            String mDuration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);

            if (isValid(mTitle)) audioFile.put("name", mTitle);
            if (isValid(mAlbum)) audioFile.put("album", mAlbum);
            if (isValid(mArtist)) {
                audioFile.put("artist", mArtist);
            }
            if (isValid(mDuration)) {
                long duration = Long.parseLong(mDuration);
                if (duration > 0 && duration < MIN_DURATION) {
                    return null;
                }
                audioFile.put("duration", duration);
            }
        } catch (Exception e) {
            android.util.Log.w("LocalMusicPlugin", "Metadata extraction failed for: " + file.getName() + " - " + e.getMessage());
        }

        return audioFile;
    }

    @PluginMethod
    public void getLocalFileUrl(PluginCall call) {
        String localPath = call.getString("localPath");
        if (!isValid(localPath)) {
            resolveError(call, "localPath is required");
            return;
        }
        if (localPath.startsWith("content://")) {
            resolveSuccess(call, "url", localPath);
            return;
        }
        File file = new File(localPath);
        if (!file.exists()) resolveError(call, "File not found");
        else resolveSuccess(call, "url", Uri.fromFile(file).toString());
    }

    @PluginMethod
    public void getEmbeddedCover(PluginCall call) {
        String localPath = call.getString("localPath");
        if (!isValid(localPath)) {
            resolveError(call, "localPath is required");
            return;
        }

        executor.execute(() -> {
            try (MediaMetadataRetriever retriever = new MediaMetadataRetriever()) {
                setRetrieverDataSource(retriever, localPath);
                byte[] picture = retriever.getEmbeddedPicture();
                if (picture == null || picture.length == 0) {
                    mainHandler.post(() -> resolveError(call, "No embedded cover"));
                    return;
                }

                String mimeType = detectImageMimeType(picture);
                String base64 = Base64.encodeToString(picture, Base64.NO_WRAP);
                JSObject result = new JSObject()
                        .put("success", true)
                        .put("dataUrl", "data:" + mimeType + ";base64," + base64);
                mainHandler.post(() -> call.resolve(result));
            } catch (Exception e) {
                mainHandler.post(() -> resolveError(call, "Failed: " + e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void getEmbeddedLyrics(PluginCall call) {
        String localPath = call.getString("localPath");
        if (!isValid(localPath)) {
            resolveError(call, "localPath is required");
            return;
        }

        executor.execute(() -> {
            try {
                String lyric = extractUsltLyrics(localPath);
                if (!isValid(lyric)) {
                    mainHandler.post(() -> resolveError(call, "No embedded lyrics"));
                    return;
                }

                JSObject result = new JSObject()
                        .put("success", true)
                        .put("lyric", lyric);
                mainHandler.post(() -> call.resolve(result));
            } catch (Exception e) {
                mainHandler.post(() -> resolveError(call, "Failed: " + e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void deleteLocalMusic(PluginCall call) {
        String localPath = call.getString("localPath");
        if (!isValid(localPath)) {
            resolveError(call, "localPath is required");
            return;
        }

        try {
            boolean deleted = false;
            ContentResolver resolver = getContext().getContentResolver();

            if (localPath.startsWith("content://")) {
                Uri contentUri = Uri.parse(localPath);
                deleted = tryDelete(() -> resolver.delete(contentUri, null, null) > 0);
            } else {
                Uri mediaUri = findMediaStoreUri(localPath);
                if (mediaUri != null) {
                    deleted = tryDelete(() -> resolver.delete(mediaUri, null, null) > 0);
                }
                if (!deleted) {
                    File file = new File(localPath);
                    deleted = !file.exists() || file.delete();
                }
            }

            if (deleted) resolveSuccess(call, null, null);
            else resolveError(call, "Failed to delete file");
        } catch (Exception e) {
            resolveError(call, "Error: " + e.getMessage());
        }
    }

    private Uri findMediaStoreUri(String filePath) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            Uri musicUri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            String[] projection = { MediaStore.Audio.Media._ID };
            String selection = MediaStore.Audio.Media.DATA + "=?";
            String[] selectionArgs = { filePath };

            try (Cursor cursor = resolver.query(musicUri, projection, selection, selectionArgs, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    long id = cursor.getLong(0);
                    return ContentUris.withAppendedId(musicUri, id);
                }
            }
        } catch (Exception e) {
            android.util.Log.w("LocalMusicPlugin", "Failed to find MediaStore URI for: " + filePath);
        }
        return null;
    }

    private boolean isSystemDirectory(File dir) {
        String path = dir.getAbsolutePath();
        File ext = Environment.getExternalStorageDirectory();
        if (ext != null) {
            String root = ext.getAbsolutePath();
            if (path.startsWith(root + "/Android/data") || path.startsWith(root + "/Android/obb")) return true;
        }
        return path.contains("/.trash") || path.contains("/.cache");
    }

    private boolean isAudioFile(String fileName) {
        if (!isValid(fileName)) return false;
        String lower = fileName.toLowerCase();
        for (String ext : AUDIO_EXTENSIONS) if (lower.endsWith(ext)) return true;
        return false;
    }

    private String resolvePlainPath(String localPath) {
        if (localPath.startsWith("file://")) {
            String path = Uri.parse(localPath).getPath();
            return path != null ? path : localPath;
        }
        return localPath;
    }

    private void setRetrieverDataSource(MediaMetadataRetriever retriever, String localPath) {
        if (localPath.startsWith("content://")) {
            retriever.setDataSource(getContext(), Uri.parse(localPath));
            return;
        }
        retriever.setDataSource(resolvePlainPath(localPath));
    }

    private String detectImageMimeType(byte[] data) {
        if (data.length >= 8
                && data[0] == (byte) 0x89
                && data[1] == 0x50
                && data[2] == 0x4E
                && data[3] == 0x47) {
            return "image/png";
        }
        if (data.length >= 12
                && data[0] == 0x52
                && data[1] == 0x49
                && data[2] == 0x46
                && data[3] == 0x46
                && data[8] == 0x57
                && data[9] == 0x45
                && data[10] == 0x42
                && data[11] == 0x50) {
            return "image/webp";
        }
        return "image/jpeg";
    }

    private String extractUsltLyrics(String localPath) throws IOException {
        try (InputStream input = openLocalInputStream(localPath)) {
            if (input == null) return null;

            byte[] header = readExact(input, 10);
            if (header == null || header[0] != 'I' || header[1] != 'D' || header[2] != '3') return null;

            int majorVersion = header[3] & 0xFF;
            int tagSize = readSynchsafeInt(header, 6);
            if (tagSize <= 0 || tagSize > 5 * 1024 * 1024) return null;

            byte[] tag = readExact(input, tagSize);
            if (tag == null) return null;

            int offset = skipExtendedHeaderIfNeeded(tag, majorVersion, header[5] & 0xFF);
            while (offset + 10 <= tag.length) {
                String frameId = new String(tag, offset, 4, StandardCharsets.ISO_8859_1);
                if (frameId.trim().isEmpty()) break;

                int frameSize = majorVersion >= 4
                        ? readSynchsafeInt(tag, offset + 4)
                        : readInt(tag, offset + 4);
                if (frameSize <= 0 || offset + 10 + frameSize > tag.length) break;

                if ("USLT".equals(frameId)) {
                    String lyric = decodeUsltFrame(Arrays.copyOfRange(tag, offset + 10, offset + 10 + frameSize));
                    return isValid(lyric) ? lyric : null;
                }

                offset += 10 + frameSize;
            }
        }
        return null;
    }

    private InputStream openLocalInputStream(String localPath) throws IOException {
        if (localPath.startsWith("content://")) {
            return getContext().getContentResolver().openInputStream(Uri.parse(localPath));
        }
        String path = resolvePlainPath(localPath);
        return new FileInputStream(path);
    }

    private byte[] readExact(InputStream input, int length) throws IOException {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(data, offset, length - offset);
            if (read < 0) return null;
            offset += read;
        }
        return data;
    }

    private int readSynchsafeInt(byte[] data, int offset) {
        return ((data[offset] & 0x7F) << 21)
                | ((data[offset + 1] & 0x7F) << 14)
                | ((data[offset + 2] & 0x7F) << 7)
                | (data[offset + 3] & 0x7F);
    }

    private int readInt(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 24)
                | ((data[offset + 1] & 0xFF) << 16)
                | ((data[offset + 2] & 0xFF) << 8)
                | (data[offset + 3] & 0xFF);
    }

    private int skipExtendedHeaderIfNeeded(byte[] tag, int majorVersion, int flags) {
        if ((flags & 0x40) == 0 || tag.length < 4) return 0;

        int size = majorVersion >= 4 ? readSynchsafeInt(tag, 0) : readInt(tag, 0);
        if (size < 0 || size > tag.length) return 0;
        return majorVersion >= 4 ? size : size + 4;
    }

    private String decodeUsltFrame(byte[] frame) {
        if (frame.length < 5) return null;

        int encoding = frame[0] & 0xFF;
        Charset charset = getId3Charset(encoding);
        int offset = 4;
        int textStart = findTextStartAfterDescription(frame, offset, encoding);
        if (textStart < 0 || textStart >= frame.length) return null;

        byte[] textBytes = Arrays.copyOfRange(frame, textStart, frame.length);
        return new String(textBytes, charset).replace("\u0000", "").trim();
    }

    private Charset getId3Charset(int encoding) {
        if (encoding == 1) return StandardCharsets.UTF_16;
        if (encoding == 2) return StandardCharsets.UTF_16BE;
        if (encoding == 3) return StandardCharsets.UTF_8;
        return StandardCharsets.ISO_8859_1;
    }

    private int findTextStartAfterDescription(byte[] frame, int offset, int encoding) {
        if (encoding == 1 || encoding == 2) {
            for (int i = offset; i + 1 < frame.length; i += 2) {
                if (frame[i] == 0 && frame[i + 1] == 0) return i + 2;
            }
            return -1;
        }

        for (int i = offset; i < frame.length; i++) {
            if (frame[i] == 0) return i + 1;
        }
        return -1;
    }

    private String extractPathFromTreeUri(Uri treeUri) {
        try {
            String docId = DocumentsContract.getTreeDocumentId(treeUri);
            int colonIndex = docId.indexOf(':');
            if (colonIndex >= 0 && colonIndex < docId.length() - 1) {
                return docId.substring(colonIndex + 1);
            }
            return "";
        } catch (Exception e) {
            android.util.Log.w("LocalMusicPlugin", "Failed to parse tree URI: " + treeUri);
            return null;
        }
    }

    private String[] parseFileName(String fileName) {
        if (!isValid(fileName)) {
            return new String[]{"未知歌曲", null};
        }

        int dot = fileName.lastIndexOf('.');
        String name = dot > 0 ? fileName.substring(0, dot) : fileName;

        int dashIndex = name.lastIndexOf(" - ");
        if (dashIndex > 0 && dashIndex < name.length() - 3) {
            String songName = name.substring(0, dashIndex).trim();
            String artistName = name.substring(dashIndex + 3).trim();
            if (isValid(songName)) {
                if (isValid(artistName)) {
                    return new String[]{songName, artistName};
                }
                return new String[]{songName, null};
            }
        }

        return new String[]{name.trim(), null};
    }

    private String formatUnknown(String value) {
        return (value == null || value.isEmpty() || "<unknown>".equals(value)) ? null : value;
    }

    private boolean isValid(String s) {
        return s != null && !s.isEmpty() && !"<unknown>".equals(s) && !"未知歌曲".equals(s);
    }

    private void resolveSuccess(PluginCall call, String key, Object value) {
        JSObject res = new JSObject().put("success", true);
        if (key != null) res.put(key, value);
        call.resolve(res);
    }

    private void resolveError(PluginCall call, String msg) {
        call.resolve(new JSObject().put("success", false).put("error", msg).put("files", new JSArray()));
    }

    private boolean tryDelete(DeleteAction action) {
        try { return action.execute(); } catch (Exception e) { return false; }
    }

    private interface DeleteAction { boolean execute() throws Exception; }
}
