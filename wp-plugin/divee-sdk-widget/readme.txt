=== Divee SDK Widget ===
Contributors: divee
Tags: ai, chat, widget, engagement, articles
Requires at least: 5.8
Tested up to: 6.9
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPL v2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Embed an AI-powered chat widget on your WordPress posts and pages with one-click setup.

== Description ==

Divee SDK is a lightweight, AI-powered widget that turns your blog posts and articles into interactive experiences. Visitors can ask context-aware questions about your content and get instant AI responses.

**Key Features:**

* **No Setup Required** - Just add your Project ID and activate
* **Context-Aware AI** - The widget understands your article content
* **Streaming Responses** - Real-time AI responses with ChatGPT-like UX
* **Smart Suggestions** - AI generates relevant questions based on your article
* **Monetization** - Built-in Google Ad Manager integration
* **Mobile Optimized** - Fully responsive design for all devices
* **Per-Post Control** - Enable/disable the widget on individual posts
* **Placement Control** - Choose top, bottom, or exact shortcode location in content
* **Zero Dependencies** - No jQuery or other external libraries needed

**How it works:**

1. Install and activate the plugin
2. Go to Settings → Divee SDK
3. Enter your Divee Project ID (get one at https://divee.ai)
4. Select which post types should show the widget
5. Choose placement mode (Top, Bottom, or Shortcode)
6. If using Shortcode mode, place `[divee_widget]` where you want the widget
7. Done! The widget appears in your selected location

Visitors will see a floating chat button that opens an AI assistant with access to your article content.

== Installation ==

1. Upload the plugin files to `/wp-content/plugins/divee-sdk-wp-plugin/`
2. Activate the plugin through the WordPress Plugins menu
3. Go to Settings → Divee SDK Settings
4. Enter your Project ID from the Divee Dashboard
5. Select which post types should display the widget
6. Choose placement mode
7. Save settings

The widget will automatically appear on your selected post types.

== Frequently Asked Questions ==

= How do I get a Project ID? =

Visit https://divee.ai to create an account and get your free Project ID from the dashboard.

= Can I disable the widget on specific posts? =

Yes. When editing a post, you'll find a "Disable Divee Widget" checkbox in the Divee Widget meta box. Check it to hide the widget on that post.

= Can I choose where the widget appears in a post? =

Yes. In plugin settings, set **Placement in Post** to one of:

* **Automatic: Bottom of post**
* **Automatic: Top of post**
* **Manual: Use [divee_widget] shortcode**

If you choose shortcode mode, place `[divee_widget]` in the post content exactly where you want the widget to appear.

= Which post types are supported? =

By default, the widget appears on Posts and Pages. You can configure other post types (including custom post types) in the settings.

= Is there a cost? =

The plugin itself is free. You'll need a Divee account to use it. Check https://divee.ai for pricing details.

= Does the widget work on mobile? =

Yes, the widget is fully optimized for mobile devices with a responsive design.

= Can I customize the appearance? =

Widget appearance (colors, position, etc.) is managed through your Divee Dashboard settings.

= What about privacy? =

The widget does not store visitor data beyond session tracking for analytics. See Divee's privacy policy at https://divee.ai/privacy for details.

== Screenshots ==

1. Widget settings page
2. Widget displayed on a blog post
3. AI chat in action

== Changelog ==

= 1.0.0 =
* Initial release
* Post and page support
* Per-post disable toggle
* Simple admin configuration
* Automatic post data injection
* Placement mode (top, bottom, shortcode)

== Upgrade Notice ==

= 1.0.0 =
Initial release. No upgrades available yet.

== Support ==

For support and documentation, visit https://divee.ai or contact support@divee.ai
