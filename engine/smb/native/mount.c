#include <stdint.h>
#include <stdlib.h>
#include <dlfcn.h>
#include <errno.h>

struct uls_session { void *library; void *server; };
/* Apple's mount_smbfs uses these SMBClient/NetFS session APIs. Keep the
 * framework loaded until the authenticated handle has been released. */
int uls_open_session(const char *url, void **connection) {
    *connection = NULL;
    struct uls_session *session = calloc(1, sizeof(*session));
    if (!session) return ENOMEM;
    session->library = dlopen("/System/Library/PrivateFrameworks/SMBClient.framework/SMBClient", RTLD_LAZY | RTLD_LOCAL);
    if (!session->library) { free(session); return ENOSYS; }
    uint32_t (*open_server)(const char *, void **, uint64_t) = dlsym(session->library, "SMBOpenServerEx");
    uint32_t (*release)(void *) = dlsym(session->library, "SMBReleaseServer");
    if (!open_server || !release) { dlclose(session->library); free(session); return ENOSYS; }
    /* SessionOnly | ForceNewSession | NoUserPreferences | NoPrompt; no guest. */
    uint32_t status = open_server(url, &session->server, 0x00010007);
    if (status != 0) {
        int error = errno ? errno : EIO;
        if (session->server) release(session->server);
        dlclose(session->library); free(session); return error;
    }
    *connection = session;
    return 0;
}
void uls_release_session(void *connection) {
    if (!connection) return;
    struct uls_session *session = connection;
    uint32_t (*release)(void *) = dlsym(session->library, "SMBReleaseServer");
    if (release) release(session->server);
    dlclose(session->library);
    free(session);
}
