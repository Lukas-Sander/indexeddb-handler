"use strict";

class Database {
    // Private Fields
    #name;  // Name of the database
    #stores; // Defines stores and caching behavior
    #db; // Actual database instance
    #memoryCache; // Cache array for quicker access of table data
    #saveTimeouts; // Per-store timeouts for saving data into IndexedDB
    #isStrict;

    constructor(name, stores, isPersistent = true, isStrict = true) {
        const me = this;
        me.#name = name;
        me.#stores = stores;
        me.#db = null;
        me.#memoryCache = {};
        me.#saveTimeouts = {};
        me.#isStrict = isStrict;
        me.#init(isPersistent);

        // Auto-save on page close or when hidden
        window.addEventListener("beforeunload", () => me.#saveAllStores());
        document.addEventListener("visibilitychange", () => {
            if(document.hidden) {
                me.#saveAllStores();
            }
        });
    }

    // ---------------------- Private Methods ----------------------

    async #init(isPersistent) {
        const me = this;
        return new Promise((resolve, reject) => {
            let upgradeNeeded = false;

            // Open the database to check the current version
            const request = indexedDB.open(me.#name);

            request.onsuccess = (event) => {
                const db = event.target.result;
                const currentVersion = db.version;
                const existingStores = new Set(db.objectStoreNames);

                // Check if new object stores need to be added
                for (const store of Object.keys(me.#stores)) {
                    if (!existingStores.has(store)) {
                        upgradeNeeded = true;
                        break;  //stop checking, we need an upgrade after any amount of new stores
                    }
                }

                if (upgradeNeeded) {
                    db.close(); // Close the DB before reopening with a higher version

                    // Open the database again with an incremented version number
                    const upgradeRequest = indexedDB.open(me.#name, currentVersion + 1);

                    upgradeRequest.onupgradeneeded = (event) => {
                        me.#db = event.target.result;
                        const newStores = new Set(me.#db.objectStoreNames);

                        for (const store of Object.keys(me.#stores)) {
                            if (!newStores.has(store)) {
                                me.#db.createObjectStore(store, { keyPath: "id" });
                            }
                        }
                    };

                    upgradeRequest.onsuccess = () => {
                        me.#db = upgradeRequest.result;
                        me.#loadMemoryCache();

                        if(isPersistent) {
                            document.addEventListener("click", me.requestPersistentStorage, { once: true });
                        }
                        resolve();
                    };

                    upgradeRequest.onerror = (event) => reject(event.target.error);
                } else {
                    // No upgrade needed, use the existing connection
                    me.#db = db;
                    me.#loadMemoryCache();

                    if(isPersistent) {
                        document.addEventListener("click", me.requestPersistentStorage, { once: true });
                    }
                    resolve();
                }
            };

            request.onerror = (event) => reject(event.target.error);
        });
    }

    async requestPersistentStorage() {
        const me = this;
        if (navigator.storage && navigator.storage.persist) {
            const isPersistent = await navigator.storage.persisted();
            if (isPersistent) {
                console.debug("Persistent storage already granted.");
                return;
            }

            console.debug("Requesting persistent storage...");
            const granted = await navigator.storage.persist();
            console.debug(`Persistent storage granted: ${granted}`);
        } else {
            console.warn("Persistent storage API not supported.");
        }

        // Remove listener after the first attempt
        document.removeEventListener("click", me.requestPersistentStorage);
    }

    async #loadMemoryCache() {
        console.debug("Loading Memory Cache");
        const me = this;

        await Promise.all(Object.keys(me.#stores).map(async (store) => {
            if (me.#stores[store].useMemoryCache !== false) {
                me.#memoryCache[store] = {};

                const tx = me.#db.transaction(store, "readonly", {durabiliy: me.#isStrict ? 'strict' : 'relaxed'});
                const storeObj = tx.objectStore(store);
                const data = await new Promise((resolve, reject) => {
                    const request = storeObj.getAll();
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = (event) => reject(event.target.error);
                });

                for (const item of data) {
                    me.#memoryCache[store][item.id] = item;
                }
            }
        }));
        console.debug(me.#memoryCache);
    }


    async #saveStore(store) {
        const me = this;
        const tx = me.#db.transaction(store, "readwrite", {durabiliy: me.#isStrict ? 'strict' : 'relaxed'});
        const storeObj = tx.objectStore(store);

        if (me.#stores[store]?.useMemoryCache === true) {
            console.debug('saving to memoryCache');
            Object.values(me.#memoryCache[store]).forEach((item) => storeObj.put(item));
        }
    }


    async #saveDirect(store, data) {
        console.debug(store, data);
        const me = this;
        const tx = me.#db.transaction(store, "readwrite", {durabiliy: me.#isStrict ? 'strict' : 'relaxed'});
        const storeObj = tx.objectStore(store);

        if (me.#stores[store]?.useMemoryCache === false) {
            console.debug('saving directly to indexedDB');
            storeObj.put(data);
        }
    }

    #saveAllStores() {
        const me = this;
        for (const store of Object.keys(me.#stores)) {
            clearTimeout(me.#saveTimeouts[store]);
            me.#saveStore(store);
        }
    }

    // ---------------------- Public Methods ----------------------

    async getAll(store) {
        console.debug('get all from store ' + store);
        const me = this;
        if (me.#stores[store]?.useMemoryCache === false) {
            return new Promise((resolve) => {
                const tx = me.#db.transaction(store, "readonly", {durabiliy: 'relaxed'});   //always use relaxed reading of data here for faster execution
                const storeObj = tx.objectStore(store);
                const request = storeObj.getAll();

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve([]);
            });
        } else {
            return Object.values(me.#memoryCache[store] || {});
        }
    }

    scheduleSave(store, id, data) {
        const me = this;
        if (me.#stores[store]?.useMemoryCache !== false) {
            me.#memoryCache[store][id] = data;

            clearTimeout(me.#saveTimeouts[store]);
            me.#saveTimeouts[store] = setTimeout(() => me.#saveStore(store), 10000);
        }
        else {
            me.#saveDirect(store, data);
            me.#saveStore(store);
        }
    }

    async delete(store, id) {
        const me = this;
        if (me.#stores[store]?.useMemoryCache !== false) {
            delete me.#memoryCache[store][id];
        }
        const tx = me.#db.transaction(store, "readwrite", {durabiliy: me.#isStrict ? 'strict' : 'relaxed'});
        tx.objectStore(store).delete(id);
    }

    query(store) {
        return new QueryBuilder(this, store);
    }

}

// ---------------------- QueryBuilder (Internal) ----------------------
class QueryBuilder {
    #database;
    #store;
    #filters;
    #sortKey;
    #sortDirection;
    #limitValue;

    constructor(database, store) {
        const me = this;
        me.#database = database;
        me.#store = store;
        me.#filters = [];
        me.#sortKey = null;
        me.#sortDirection = "asc";
        me.#limitValue = null;
    }

    where(field) {
        const me = this;
        return {
            equals: (value) => {
                me.#filters.push((item) => item[field] === value);
                return me;
            },
            greaterThan: (value) => {
                me.#filters.push((item) => item[field] > value);
                return me;
            },
            lessThan: (value) => {
                me.#filters.push((item) => item[field] < value);
                return me;
            },
        };
    }

    orderBy(field, direction = "asc") {
        const me = this;
        me.#sortKey = field;
        me.#sortDirection = direction;
        return me;
    }

    limit(value) {
        const me = this;
        me.#limitValue = value;
        return me;
    }

    async execute() {
        const me = this;
        const data = await me.#database.getAll(me.#store);

        let result = data.filter((item) => me.#filters.every((f) => f(item)));

        if (me.#sortKey) {
            result.sort((a, b) => {
                if (a[me.#sortKey] < b[me.#sortKey]) {
                    return me.#sortDirection === "asc" ? -1 : 1;
                }
                if (a[me.#sortKey] > b[me.#sortKey]) {
                    return me.#sortDirection === "asc" ? 1 : -1;
                }
                return 0;
            });
        }

        if (me.#limitValue !== null) {
            result = result.slice(0, me.#limitValue);
        }

        return result;
    }
}