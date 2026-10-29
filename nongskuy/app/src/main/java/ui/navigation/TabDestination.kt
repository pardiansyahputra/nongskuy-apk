package app.nongskuy.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Enum untuk 4 tab utama NONGSKUY.
 */
enum class TabDestination(
    val route: String,
    val label: String,
    val icon: ImageVector
) {
    Map(
        route = "tab_map",
        label = "Peta",
        icon = Icons.Default.Map
    ),
    Chat(
        route = "tab_chat",
        label = "Chat",
        icon = Icons.Default.Chat
    ),
    Group(
        route = "tab_group",
        label = "Grup",
        icon = Icons.Default.Groups
    ),
    Settings(
        route = "tab_settings",
        label = "Setting",
        icon = Icons.Default.Settings
    )
}